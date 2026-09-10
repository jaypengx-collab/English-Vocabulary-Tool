#!/usr/bin/env python3
"""Pre-generates one MP3 pronunciation clip per vocabulary word.

The app used to rely on the browser's Web Speech API (speechSynthesis),
whose quality depends entirely on whatever voices happen to be installed
on the user's OS/browser - often robotic or inconsistent. This script
instead renders every word once, offline, using a single high-quality
neural voice (Microsoft Edge's online TTS service via the open-source
`edge-tts` package - no API key required), and commits the resulting
clips as static files the app fetches on demand. See app.js's speak()
for the playback side (falls back to speechSynthesis if a clip is
missing, e.g. for a word added before its audio was (re)generated).

Usage:
    pip install edge-tts
    python3 scripts/generate_audio.py [--voice VOICE_NAME] [--concurrency N]

Safe to re-run: existing files are skipped, so interrupting and resuming
(or regenerating after adding new words to data/vocab.json) only fills in
what's missing.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent.parent
VOCAB_PATH = ROOT / "data" / "vocab.json"
AUDIO_DIR = ROOT / "data" / "audio"

DEFAULT_VOICE = "en-US-JennyNeural"
MAX_RETRIES = 4


def audio_filename(word):
    return f"{word.lower()}.mp3"


async def generate_one(word, voice, semaphore):
    out_path = AUDIO_DIR / audio_filename(word)
    if out_path.exists() and out_path.stat().st_size > 0:
        return "skip"

    async with semaphore:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                communicate = edge_tts.Communicate(word, voice)
                tmp_path = out_path.with_suffix(".mp3.tmp")
                await communicate.save(str(tmp_path))
                if tmp_path.stat().st_size == 0:
                    raise RuntimeError("empty audio output")
                tmp_path.rename(out_path)
                return "ok"
            except Exception as exc:  # noqa: BLE001 - retry any transient failure
                if attempt == MAX_RETRIES:
                    print(f"FAILED: {word!r}: {exc}", file=sys.stderr)
                    return "fail"
                await asyncio.sleep(1.5 * attempt)
    return "fail"


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--limit", type=int, default=None, help="only process the first N words (for testing)")
    args = parser.parse_args()

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    vocab = json.loads(VOCAB_PATH.read_text(encoding="utf-8"))
    words = [w["word"] for w in vocab]
    if args.limit:
        words = words[: args.limit]

    semaphore = asyncio.Semaphore(args.concurrency)
    tasks = [generate_one(w, args.voice, semaphore) for w in words]

    results = {"ok": 0, "skip": 0, "fail": 0}
    done = 0
    for coro in asyncio.as_completed(tasks):
        outcome = await coro
        results[outcome] += 1
        done += 1
        if done % 100 == 0 or done == len(words):
            print(f"[{done}/{len(words)}] ok={results['ok']} skip={results['skip']} fail={results['fail']}")

    print(f"Done. ok={results['ok']} skip={results['skip']} fail={results['fail']} voice={args.voice}")
    if results["fail"]:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
