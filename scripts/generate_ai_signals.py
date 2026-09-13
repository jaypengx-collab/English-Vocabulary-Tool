#!/usr/bin/env python3
"""Pre-generates AI-derived study signals for every vocabulary word.

For each word in data/vocab.json, asks the Gemini API for:
  - confusedWith: other words FROM data/vocab.json commonly confused with
    this one, semantically (affect/effect) or visually (quiet/quite) - not
    just letter-overlap.
  - mnemonic: a short (<20 words) memory hook.
  - priorDifficulty: a 0.0-1.0 cold-start difficulty estimate for a
    Taiwanese high-schooler, used by logic.js's computeDifficultyBaseline
    only until real attempt data exists for a word.

Results are written to data/ai_signals.json (a dict keyed by word), loaded
by the app as a static asset exactly like data/vocab.json - never fetched
at runtime. See logic.js's computeInterferenceModel/computeDifficultyBaseline
for the consuming side.

For confusedWith to be trustworthy, every request includes the FULL
vocabulary list (word/pos/level only, zh dropped to save tokens) as
reference context, alongside a batch of ~40-50 "target" words to actually
produce output for - so the model can spot real cross-list confusions
instead of guessing from general training knowledge. Even so, the model's
response is defensively filtered against the real vocab list afterwards:
any confusedWith entry that isn't a literal match is dropped rather than
trusted.

Usage:
    export GEMINI_API_KEY=...   # from https://aistudio.google.com/apikey
    python3 scripts/generate_ai_signals.py [--model MODEL] [--batch-size N] [--concurrency N] [--limit N]

No extra pip install needed - uses only the standard library (urllib) to
call the generativelanguage.googleapis.com REST API directly.

Safe to re-run: words already present in data/ai_signals.json are skipped,
so interrupting and resuming (or regenerating after adding new words to
data/vocab.json) only fills in what's missing. Progress is written to disk
after every completed batch, not just at the end.
"""

import argparse
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOCAB_PATH = ROOT / "data" / "vocab.json"
SIGNALS_PATH = ROOT / "data" / "ai_signals.json"

API_URL_TEMPLATE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-3.6-flash"
DEFAULT_BATCH_SIZE = 45
DEFAULT_CONCURRENCY = 3
MAX_RETRIES = 4
REQUEST_TIMEOUT_S = 180

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "words": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "word": {"type": "STRING"},
                    "confusedWith": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "mnemonic": {"type": "STRING"},
                    "priorDifficulty": {"type": "NUMBER"},
                },
                "required": ["word", "confusedWith", "mnemonic", "priorDifficulty"],
            },
        },
    },
    "required": ["words"],
}


def build_prompt(reference_rows, target_rows):
    return (
        "You are helping build a vocabulary study app for Taiwanese high "
        "school students learning English. Below is the FULL reference "
        "vocabulary list used by this app (word, part of speech, curriculum "
        "level 1-6), given as compact [word, pos, level] rows. Use it ONLY "
        "to decide which OTHER words in this exact list are commonly "
        "confused with each target word.\n\n"
        f"REFERENCE LIST ({len(reference_rows)} words):\n"
        f"{json.dumps(reference_rows, ensure_ascii=False)}\n\n"
        "For each TARGET WORD below, produce:\n"
        "- confusedWith: 0-5 words commonly confused with the target word, "
        "either semantically (e.g. affect/effect, economic/economical) or "
        "visually (similar spelling/shape, e.g. quiet/quite, dessert/desert). "
        "Every entry MUST be copied EXACTLY (same spelling and casing) from "
        "the REFERENCE LIST above. Never invent a word or include one that "
        "is not literally in that list, and never include the target word "
        "itself.\n"
        "- mnemonic: one short memory hook (under 20 words) for the word's "
        "spelling or meaning.\n"
        "- priorDifficulty: a number from 0.0 (very easy) to 1.0 (very hard) "
        "estimating how hard this word is for a Taiwanese high-schooler to "
        "spell and learn.\n\n"
        f"TARGET WORDS ({len(target_rows)} words):\n"
        f"{json.dumps(target_rows, ensure_ascii=False)}\n"
    )


def call_gemini(prompt, model, api_key):
    url = API_URL_TEMPLATE.format(model=model)
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    text = payload["candidates"][0]["content"]["parts"][0]["text"]
    parsed = json.loads(text)
    words = parsed.get("words")
    if not isinstance(words, list):
        raise ValueError("response JSON missing a 'words' array")
    return words


def clean_item(item, vocab_by_lower):
    """Defensively validates/normalizes one model-returned entry against the
    real vocab list, dropping anything hallucinated rather than trusting the
    model's compliance with the prompt's own instructions."""
    if not isinstance(item, dict):
        return None
    raw_word = item.get("word")
    if not isinstance(raw_word, str):
        return None
    canonical = vocab_by_lower.get(raw_word.strip().lower())
    if not canonical:
        return None  # target word itself isn't a real vocab word - drop it

    confused = []
    seen = set()
    for c in item.get("confusedWith") or []:
        if not isinstance(c, str):
            continue
        match = vocab_by_lower.get(c.strip().lower())
        if not match or match == canonical or match in seen:
            continue
        seen.add(match)
        confused.append(match)

    mnemonic = item.get("mnemonic")
    mnemonic = mnemonic.strip() if isinstance(mnemonic, str) else ""

    prior = item.get("priorDifficulty")
    prior = float(prior) if isinstance(prior, (int, float)) else 0.5
    prior = max(0.0, min(1.0, prior))

    return canonical, {"confusedWith": confused, "mnemonic": mnemonic, "priorDifficulty": prior}


async def generate_batch(batch, reference_rows, model, api_key, semaphore, loop):
    target_rows = [[w["word"], w["level"]] for w in batch]
    prompt = build_prompt(reference_rows, target_rows)
    async with semaphore:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                return await loop.run_in_executor(None, call_gemini, prompt, model, api_key)
            except Exception as exc:  # noqa: BLE001 - retry any transient failure (network, rate limit, bad JSON)
                if attempt == MAX_RETRIES:
                    sample = batch[0]["word"] if batch else "?"
                    print(f"FAILED batch starting {sample!r} ({len(batch)} words): {exc}", file=sys.stderr)
                    return None
                await asyncio.sleep(2 * attempt)
    return None


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="target words per request")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--limit", type=int, default=None, help="only process the first N words (for testing)")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print(
            "GEMINI_API_KEY environment variable is not set. Get a key from "
            "https://aistudio.google.com/apikey and export it before running "
            "this script, e.g.:\n\n  export GEMINI_API_KEY=...\n  python3 scripts/generate_ai_signals.py",
            file=sys.stderr,
        )
        sys.exit(1)

    vocab = json.loads(VOCAB_PATH.read_text(encoding="utf-8"))
    vocab_by_lower = {w["word"].lower(): w["word"] for w in vocab}
    reference_rows = [[w["word"], w["pos"], w["level"]] for w in vocab]

    signals = {}
    if SIGNALS_PATH.exists():
        signals = json.loads(SIGNALS_PATH.read_text(encoding="utf-8"))

    words = vocab[: args.limit] if args.limit else vocab
    pending = [w for w in words if w["word"] not in signals]
    if not pending:
        print(f"Nothing to do - all {len(words)} words already have signals.")
        return

    batches = [pending[i : i + args.batch_size] for i in range(0, len(pending), args.batch_size)]
    semaphore = asyncio.Semaphore(args.concurrency)
    loop = asyncio.get_event_loop()
    tasks = [generate_batch(b, reference_rows, args.model, api_key, semaphore, loop) for b in batches]

    total_batches = len(batches)
    batches_done = 0
    words_written = 0
    failed_batches = 0
    for coro in asyncio.as_completed(tasks):
        result = await coro
        batches_done += 1
        if result is None:
            failed_batches += 1
        else:
            for item in result:
                cleaned = clean_item(item, vocab_by_lower)
                if cleaned:
                    word, data = cleaned
                    signals[word] = data
                    words_written += 1
            SIGNALS_PATH.write_text(
                json.dumps(signals, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
        print(f"[{batches_done}/{total_batches} batches] words_written={words_written} failed_batches={failed_batches}")

    print(f"Done. words_written={words_written} failed_batches={failed_batches} total_words_with_signals={len(signals)}")
    if failed_batches:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
