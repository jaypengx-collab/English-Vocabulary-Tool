"use strict";

// Stamped with the short git commit SHA by the Pages deploy workflow
// (see .github/workflows/pages.yml). Stays as the literal placeholder
// when running locally without that build step.
const APP_VERSION = "__BUILD_VERSION__";

// All memorization scoring, question-selection ratios, and progress-store
// migration live in logic.js as pure/DOM-free, unit-tested functions (see
// tests/logic.test.js). This file only owns storage I/O, DOM rendering,
// and speech synthesis - see README/section "Architecture" for the split.
const Logic = window.VocabLogic;

const PROGRESS_KEY = "vocab_progress_v1";
const SETTINGS_KEY = "vocab_settings_v1";

/* ---------- Storage helpers ---------- */

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable - ignore, app still works without persistence */
  }
}

// progressStore: { "word-lowercased" -> word-history object, see
// logic.js#createEmptyWordHistory }. Migrated below (after vocab loads) so
// legacy entries from before this rewrite - and any entry missing a field
// a later version added - are upgraded in place without losing progress.
let progressStore = loadJSON(PROGRESS_KEY, {});
let settings = Object.assign(
  { levels: [4, 5, 6], rate: 0.9, sessionSize: 80, reviewSize: 20 },
  loadJSON(SETTINGS_KEY, {})
);

function persistProgress() {
  saveJSON(PROGRESS_KEY, progressStore);
}

// Every local mutation to progressStore funnels through this (recordResult,
// import, reset) - each one is a real change worth syncing, so this is also
// the one place that tells sync.js "this device now has something newer
// than the last thing it pushed" (see that file's notifyLocalChange). A
// no-op when sync isn't set up (window.VocabSync always exists once
// sync.js loads, but its own isSyncConfigured() gate makes the call itself
// harmless either way).
function saveProgress() {
  persistProgress();
  if (window.VocabSync) window.VocabSync.notifyLocalChange();
}

function saveSettings() {
  saveJSON(SETTINGS_KEY, settings);
  if (window.VocabSync) window.VocabSync.notifyLocalChange();
}

// Reflects `settings` onto the home-screen controls that mirror it (rate
// slider, session/review size fields) - shared by init() and by anything
// that replaces `settings` wholesale from outside a direct user edit
// (import, an applied sync snapshot) so those two paths don't each keep
// their own copy of the same four DOM writes.
function applySettingsToUI() {
  document.getElementById("rate-select").value = settings.rate;
  document.getElementById("rate-value").textContent = `${settings.rate.toFixed(1)}x`;
  document.getElementById("session-size").value = String(settings.sessionSize);
  document.getElementById("review-size").value = String(settings.reviewSize);
}

// The read/write surface sync.js (and, in principle, anything else outside
// this file) uses to get at progressStore/settings - both are plain
// module-scoped `let` bindings, not properties of `window`, so this is the
// one seam between the two files rather than each function in sync.js
// reaching into app.js's internals directly.
window.VocabState = {
  getProgress: () => progressStore,
  getSettings: () => settings,
  // Replaces progressStore/settings wholesale - used when applying a
  // snapshot that came from ANOTHER device via sync (or from this
  // device's own pre-join backup being restored), never for a normal
  // local edit. Persists locally but deliberately does NOT go through
  // saveProgress()/saveSettings() above, since re-pushing data that was
  // just pulled (or restored from a backup of what was already pushed)
  // isn't a new local change to sync back out.
  applySyncedSnapshot(remoteProgress, remoteSettings) {
    progressStore = Logic.migrateProgressStore(remoteProgress || {}, VOCAB_INDEX);
    persistProgress();
    if (remoteSettings && typeof remoteSettings === "object") {
      settings = Object.assign({}, settings, remoteSettings);
      saveJSON(SETTINGS_KEY, settings);
      applySettingsToUI();
    }
    if (document.getElementById("view-progress").classList.contains("active")) renderProgress();
    if (document.getElementById("view-reviewlist").classList.contains("active")) renderReviewList();
  },
};

// Fetches (creating if needed) the history entry for a vocab item and
// records one answer into it. Used by BOTH the Vocabulary Test and the
// Review Test, so the two modes share one system rather than drifting
// apart, per the app's design. `answer` is the exact text the user typed -
// recorded (only when wrong) so a mistake can be reviewed later instead of
// just a bare correct/incorrect flag.
function recordResult(item, correct, responseMs, answer) {
  const key = item.word.toLowerCase();
  if (!progressStore[key]) {
    progressStore[key] = Logic.createEmptyWordHistory(item.word, item.level, item.word.length);
  }
  const history = progressStore[key];
  const priorAvg = history.avgCorrectResponseMs;
  Logic.recordAttempt(history, {
    correct: correct,
    responseMs: responseMs,
    answer: answer,
    timestamp: Date.now(),
    level: item.level,
    length: item.word.length,
  });
  saveProgress();
  return { history: history, priorAvg: priorAvg };
}

/* ---------- Vocabulary data ---------- */

let VOCAB = [];
let VOCAB_BY_LEVEL = { 4: [], 5: [], 6: [] };
let VOCAB_INDEX = {}; // word.toLowerCase() -> {word, level}, also reused by import below

function buildVocabIndex() {
  const index = {};
  for (const w of VOCAB) index[w.word.toLowerCase()] = { word: w.word, level: w.level };
  return index;
}

async function loadVocab() {
  const res = await fetch("data/vocab.json?v=__BUILD_VERSION__");
  VOCAB = await res.json();
  VOCAB_BY_LEVEL = { 4: [], 5: [], 6: [] };
  for (const w of VOCAB) VOCAB_BY_LEVEL[w.level].push(w);
  VOCAB_INDEX = buildVocabIndex();
  document.getElementById("footer-total").textContent = VOCAB.length;

  // Backward-compatible migration: upgrades legacy Leitner-box entries (and
  // fills in any newly-added fields on already-current entries) without
  // resetting existing progress. Safe to run on every load - it's a no-op
  // merge once everything is already in the current shape.
  progressStore = Logic.migrateProgressStore(progressStore, VOCAB_INDEX);
  saveProgress();
}

function selectedLevels() {
  return Array.from(document.querySelectorAll('#level-picker input:checked')).map(
    (el) => Number(el.value)
  );
}

function wordsForLevels(levels) {
  let pool = [];
  for (const lvl of levels) pool = pool.concat(VOCAB_BY_LEVEL[lvl] || []);
  return pool;
}

/* ---------- Chinese meaning rendering ---------- */

// ECDICT stores multiple part-of-speech senses joined with a literal
// backslash-n sequence (not a real newline character) - split on that.
function zhLines(zh) {
  return zh ? zh.split("\\n") : ["（無中文釋義）"];
}

function buildZhBlock(zh) {
  const div = document.createElement("div");
  div.className = "zh-meaning";
  zhLines(zh).forEach((line, i) => {
    if (i > 0) div.appendChild(document.createElement("br"));
    div.appendChild(document.createTextNode(line));
  });
  return div;
}

// A clickable chip that reveals a word's Chinese meaning on tap - used in
// the end-of-round summaries.
function buildWordChip(item) {
  const wrap = document.createElement("div");
  wrap.className = "word-chip";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "word-chip-btn";
  btn.textContent = `${item.word} `;
  const posSpan = document.createElement("span");
  posSpan.className = "muted";
  posSpan.textContent = item.pos;
  btn.appendChild(posSpan);

  const zhDiv = document.createElement("div");
  zhDiv.className = "word-chip-zh hidden";
  zhLines(item.zh).forEach((line, i) => {
    if (i > 0) zhDiv.appendChild(document.createElement("br"));
    zhDiv.appendChild(document.createTextNode(line));
  });

  btn.addEventListener("click", () => zhDiv.classList.toggle("hidden"));

  wrap.appendChild(btn);
  wrap.appendChild(zhDiv);
  return wrap;
}

function renderWordChipList(containerEl, items) {
  containerEl.innerHTML = "";
  const list = document.createElement("div");
  list.className = "word-chip-list";
  items.forEach((item) => list.appendChild(buildWordChip(item)));
  containerEl.appendChild(list);
}

/* ---------- Text to speech ---------- */

// Only ever used as a fallback (see speak() below), so there is nothing to
// expose in the UI: whenever the browser's voice list changes, silently
// pick the single best-available English voice instead of asking the user
// to choose among dozens of inconsistent OS/browser voices.
let fallbackVoice = null;

function pickBestVoice(list) {
  if (!list.length) return null;
  // Prefer higher-quality "Natural"/"Online" neural voices when the
  // browser exposes them (Edge/Chrome on Windows commonly do), then any
  // US English voice, then any English voice, then whatever's first.
  const rules = [
    (v) => /en-US/i.test(v.lang) && /natural|online|neural/i.test(v.name),
    (v) => /^en/i.test(v.lang) && /natural|online|neural/i.test(v.name),
    (v) => /en-US/i.test(v.lang),
    (v) => /^en/i.test(v.lang),
  ];
  for (const matches of rules) {
    const found = list.find(matches);
    if (found) return found;
  }
  return list[0];
}

function refreshVoices() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  fallbackVoice = pickBestVoice(voices);
}

// Browser speechSynthesis quality varies wildly by OS/browser (often
// robotic or missing decent English voices entirely), so every vocab word
// is pre-rendered once, offline, with a single good neural voice (see
// scripts/generate_audio.py) and shipped as a static clip. This is the
// primary playback path; speechSynthesis is kept only as a fallback for
// the rare case a clip fails to load (e.g. a word added without
// regenerating audio yet, or a network hiccup on first fetch).
function speakWithWebSpeech(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  if (fallbackVoice) {
    utter.voice = fallbackVoice;
    utter.lang = fallbackVoice.lang;
  } else {
    utter.lang = "en-US";
  }
  utter.rate = settings.rate;
  window.speechSynthesis.speak(utter);
}

function localAudioUrl(word) {
  return `data/audio/${encodeURIComponent(word.toLowerCase())}.mp3?v=__BUILD_VERSION__`;
}

// Playback uses the Web Audio API (AudioContext + AudioBufferSourceNode)
// rather than an <audio>/new Audio() element on purpose: an HTMLMediaElement
// registers a system media session, which on iOS - especially for a page
// added to the home screen (standalone display mode) - pops open the
// Dynamic Island / Control Center "now playing" indicator on every single
// word. Raw Web Audio buffer playback doesn't register a media session at
// all, so it stays silent to the OS chrome. Decoded clips are cached per
// word (by lowercase word) since the same word is often replayed.
let audioCtx = null;
const audioBufferCache = new Map(); // word.toLowerCase() -> Promise<AudioBuffer>
let currentSource = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  // iOS suspends the context until a user gesture resumes it; calling this
  // synchronously at the top of speak() (itself always called from a click/
  // submit/keydown handler) keeps it unlocked for the async playback below.
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

function loadAudioBuffer(word) {
  const key = word.toLowerCase();
  if (audioBufferCache.has(key)) return audioBufferCache.get(key);
  const promise = fetch(localAudioUrl(word))
    .then((res) => {
      if (!res.ok) throw new Error(`audio fetch failed: ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => getAudioContext().decodeAudioData(buf))
    .catch((err) => {
      audioBufferCache.delete(key); // let a later call retry instead of caching the failure forever
      throw err;
    });
  audioBufferCache.set(key, promise);
  return promise;
}

function speak(word) {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  const ctx = getAudioContext();
  if (currentSource) {
    try {
      currentSource.stop();
    } catch (e) {
      /* already stopped/finished - fine to ignore */
    }
    currentSource = null;
  }

  loadAudioBuffer(word)
    .then((buffer) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = settings.rate;
      source.connect(ctx.destination);
      currentSource = source;
      source.start(0);
    })
    .catch(() => speakWithWebSpeech(word));
}

/* ---------- View navigation ---------- */

function showView(name) {
  document.querySelectorAll(".view").forEach((el) => el.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  if (name === "progress") renderProgress();
  if (name === "reviewlist") renderReviewList();
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (btn) showView(btn.dataset.view);
});

/* ---------- Home / setup view ---------- */

function updateLevelHint() {
  const levels = selectedLevels();
  const counts = levels.map((l) => `Level ${l}: ${VOCAB_BY_LEVEL[l].length}`);
  const total = wordsForLevels(levels).length;
  document.getElementById("level-count-hint").textContent = levels.length
    ? `已選 ${total} 個單字（${counts.join("、")}）`
    : "請至少選擇一個等級";
}

document.getElementById("level-picker").addEventListener("change", (e) => {
  const checked = document.querySelectorAll('#level-picker input:checked');
  if (checked.length === 0) {
    e.target.checked = true; // must keep at least one level selected
  }
  updateLevelHint();
});

// Vocabulary Test and Review Test are two peer modes the user picks
// between on the home screen (each only starts via its own button here -
// see the note on start-test-btn/start-review-btn for why there's no top
// nav tab for either). Switching modes just swaps which settings/start
// button are visible; it doesn't touch either mode's in-progress state.
document.getElementById("mode-picker").addEventListener("change", (e) => {
  const mode = e.target.value;
  document.getElementById("test-mode-settings").classList.toggle("hidden", mode !== "test");
  document.getElementById("review-mode-settings").classList.toggle("hidden", mode !== "review");
});

document.getElementById("rate-select").addEventListener("input", (e) => {
  settings.rate = Number(e.target.value);
  document.getElementById("rate-value").textContent = `${settings.rate.toFixed(1)}x`;
  saveSettings();
});

// Lets the user actually hear a real word at the currently-selected speed
// before starting a test, using the same local-audio playback path as the
// test itself (so what they hear here is exactly what they'll get).
document.getElementById("test-voice-btn").addEventListener("click", () => {
  if (!VOCAB.length) return;
  const sample = VOCAB[Math.floor(Math.random() * VOCAB.length)];
  document.getElementById("test-voice-word").textContent = `範例單字：${sample.word}`;
  speak(sample.word);
});

function setSessionSize(size) {
  const clamped = Math.max(0, Math.floor(size) || 0);
  settings.sessionSize = clamped;
  document.getElementById("session-size").value = String(clamped);
  saveSettings();
}

document.getElementById("session-size").addEventListener("change", (e) => {
  setSessionSize(Number(e.target.value));
});

document.getElementById("session-size-presets").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-size]");
  if (!btn) return;
  setSessionSize(Number(btn.dataset.size));
});

function setReviewSize(size) {
  const clamped = Math.max(0, Math.floor(size) || 0);
  settings.reviewSize = clamped;
  document.getElementById("review-size").value = String(clamped);
  saveSettings();
}

document.getElementById("review-size").addEventListener("change", (e) => {
  setReviewSize(Number(e.target.value));
});

document.getElementById("review-size-presets").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-size]");
  if (!btn) return;
  setReviewSize(Number(btn.dataset.size));
});

/* ---------- Shared quiz mechanics (used by both Vocabulary Test and Review Test) ---------- */

// A self-relative note about this attempt's speed vs THIS word's own past
// average - never a fixed threshold, never a function of word length.
// `priorAvg` is the word's avgCorrectResponseMs from BEFORE this attempt
// was recorded, so the comparison is against genuine prior history.
function speedNote(priorAvg, elapsedMs) {
  if (priorAvg == null) return null;
  if (elapsedMs <= priorAvg * 0.85) return { cls: "faster", text: "⚡ 比你這個字平常的速度快！" };
  if (elapsedMs >= priorAvg * 1.4) return { cls: "slower", text: "🐢 比這個字平常的速度慢一些，可能還沒完全記熟。" };
  return null;
}

function renderAnswerFeedback(feedbackEl, item, correct, guess, note) {
  feedbackEl.classList.remove("hidden", "correct", "wrong");
  feedbackEl.innerHTML = "";

  const title = document.createElement("div");
  const answerWord = document.createElement("div");
  answerWord.className = "answer-word";
  if (correct) {
    feedbackEl.classList.add("correct");
    title.textContent = "✅ 正確！";
    answerWord.textContent = `${item.word} `;
  } else {
    feedbackEl.classList.add("wrong");
    title.textContent = `❌ 再加油　你的答案：${guess || "(空白)"}`;
    answerWord.textContent = `正確答案：${item.word} `;
  }
  const posSpan = document.createElement("span");
  posSpan.className = "muted";
  posSpan.textContent = item.pos;
  answerWord.appendChild(posSpan);

  feedbackEl.appendChild(title);
  feedbackEl.appendChild(answerWord);
  feedbackEl.appendChild(buildZhBlock(item.zh));

  if (note) {
    const noteEl = document.createElement("div");
    noteEl.className = `speed-note ${note.cls}`;
    noteEl.textContent = note.text;
    feedbackEl.appendChild(noteEl);
  }
}

/* ---------- Vocabulary Test mode ---------- */

const vocabTest = { list: [], index: 0, correctCount: 0, missed: [], answered: false, wordShownAt: 0, inProgress: false };

// The Vocabulary Test view has no top-level tab of its own - it's only
// ever entered from this button, and navigating away mid-round (e.g. to
// check Progress) and back must resume exactly where it left off rather
// than silently discarding the round. The underlying view stays in the
// DOM (just hidden via CSS) while inactive, so simply re-showing it is
// enough to restore its on-screen state; only a *finished* round (or no
// round at all yet) should build a fresh one.
document.getElementById("start-test-btn").addEventListener("click", () => {
  if (vocabTest.inProgress) {
    showView("test");
    return;
  }
  const levels = selectedLevels();
  if (!levels.length) return;
  const pool = wordsForLevels(levels);
  const size = settings.sessionSize && settings.sessionSize > 0 ? settings.sessionSize : pool.length;
  vocabTest.list = Logic.selectTestQuestions({ pool: pool, historyStore: progressStore, size: size });
  vocabTest.index = 0;
  vocabTest.correctCount = 0;
  vocabTest.missed = [];
  vocabTest.inProgress = true;
  document.getElementById("test-summary").classList.add("hidden");
  document.getElementById("test-form").classList.remove("hidden");
  showView("test");
  showTestWord();
});

function showTestWord() {
  const total = vocabTest.list.length;
  const item = vocabTest.list[vocabTest.index];
  document.getElementById("test-progress-text").textContent = `${vocabTest.index + 1} / ${total}`;
  document.getElementById("test-progress-fill").style.width = `${(vocabTest.index / total) * 100}%`;
  document.getElementById("test-level-badge").textContent = `Level ${item.level}`;

  vocabTest.answered = false;
  const input = document.getElementById("test-input");
  input.value = "";
  input.disabled = false;
  document.getElementById("test-submit-btn").disabled = false;
  document.getElementById("test-feedback").classList.add("hidden");
  document.getElementById("test-next-btn").classList.add("hidden");
  input.focus();

  vocabTest.wordShownAt = Date.now();
  speak(item.word);
}

document.getElementById("test-play-btn").addEventListener("click", () => {
  speak(vocabTest.list[vocabTest.index].word);
});
document.getElementById("test-replay-btn").addEventListener("click", () => {
  speak(vocabTest.list[vocabTest.index].word);
});

document.getElementById("test-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (vocabTest.answered) {
    advanceTest();
    return;
  }
  const item = vocabTest.list[vocabTest.index];
  const input = document.getElementById("test-input");
  const guess = input.value.trim().toLowerCase();
  const correct = guess === item.word.toLowerCase();
  const elapsed = Date.now() - vocabTest.wordShownAt;

  const { priorAvg } = recordResult(item, correct, elapsed, guess);
  vocabTest.answered = true;
  input.disabled = true;
  if (correct) vocabTest.correctCount += 1;
  else vocabTest.missed.push(item);

  const note = correct ? speedNote(priorAvg, elapsed) : null;
  renderAnswerFeedback(document.getElementById("test-feedback"), item, correct, guess, note);

  const isLast = vocabTest.index === vocabTest.list.length - 1;
  const nextBtn = document.getElementById("test-next-btn");
  nextBtn.textContent = isLast ? "看結果 →" : "下一題 →";
  nextBtn.classList.remove("hidden");
});

document.getElementById("test-next-btn").addEventListener("click", advanceTest);

function advanceTest() {
  if (vocabTest.index < vocabTest.list.length - 1) {
    vocabTest.index += 1;
    showTestWord();
  } else {
    finishTest();
  }
}

function finishTest() {
  vocabTest.inProgress = false;
  document.getElementById("test-progress-fill").style.width = "100%";
  document.getElementById("test-form").classList.add("hidden");
  document.getElementById("test-feedback").classList.add("hidden");
  document.getElementById("test-next-btn").classList.add("hidden");

  const total = vocabTest.list.length;
  document.getElementById("test-summary-score").textContent =
    `答對 ${vocabTest.correctCount} / ${total} 題（${Math.round((vocabTest.correctCount / total) * 100)}%）`;

  const missedDiv = document.getElementById("test-summary-missed");
  missedDiv.innerHTML = "";
  if (vocabTest.missed.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "拼錯的單字（點擊查看中文意思，已加入複習測驗清單）：";
    missedDiv.appendChild(p);
    const holder = document.createElement("div");
    missedDiv.appendChild(holder);
    renderWordChipList(holder, vocabTest.missed);
  } else {
    missedDiv.innerHTML = `<p class="hint">全部答對，太厲害了！🎉</p>`;
  }

  const allDiv = document.getElementById("test-summary-all");
  allDiv.innerHTML = "";
  const allP = document.createElement("p");
  allP.className = "hint";
  allP.textContent = "本回合全部單字（點擊查看中文意思）：";
  allDiv.appendChild(allP);
  const allHolder = document.createElement("div");
  allDiv.appendChild(allHolder);
  renderWordChipList(allHolder, vocabTest.list);

  document.getElementById("test-summary").classList.remove("hidden");
}

document.getElementById("test-again-btn").addEventListener("click", () => {
  document.getElementById("start-test-btn").click();
});
document.getElementById("test-home-btn").addEventListener("click", () => showView("home"));

/* ---------- Review Test mode (auto-quizzes the wrong-word list) ---------- */

const reviewTest = { list: [], index: 0, records: [], answered: false, wordShownAt: 0, inProgress: false };

// Same "no dedicated tab, resume on return" rule as the Vocabulary Test -
// see the comment on start-test-btn above.
document.getElementById("start-review-btn").addEventListener("click", () => {
  if (reviewTest.inProgress) {
    showView("review");
    return;
  }
  const levels = selectedLevels();
  if (!levels.length) return;
  const pool = wordsForLevels(levels);
  reviewTest.list = Logic.buildReviewTestList({ pool: pool, historyStore: progressStore, size: settings.reviewSize });
  reviewTest.index = 0;
  reviewTest.records = [];

  showView("review");
  const empty = document.getElementById("rev-empty");
  const body = document.getElementById("rev-body");
  const summary = document.getElementById("rev-summary");
  summary.classList.add("hidden");

  if (!reviewTest.list.length) {
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  reviewTest.inProgress = true;
  empty.classList.add("hidden");
  body.classList.remove("hidden");
  document.getElementById("rev-form").classList.remove("hidden");
  showReviewWord();
});

document.getElementById("rev-empty-home-btn").addEventListener("click", () => showView("home"));

function showReviewWord() {
  const total = reviewTest.list.length;
  const item = reviewTest.list[reviewTest.index];
  document.getElementById("rev-progress-text").textContent = `${reviewTest.index + 1} / ${total}`;
  document.getElementById("rev-progress-fill").style.width = `${(reviewTest.index / total) * 100}%`;
  document.getElementById("rev-level-badge").textContent = `Level ${item.level}`;

  reviewTest.answered = false;
  const input = document.getElementById("rev-input");
  input.value = "";
  input.disabled = false;
  document.getElementById("rev-submit-btn").disabled = false;
  document.getElementById("rev-feedback").classList.add("hidden");
  document.getElementById("rev-next-btn").classList.add("hidden");
  input.focus();

  reviewTest.wordShownAt = Date.now();
  speak(item.word);
}

document.getElementById("rev-play-btn").addEventListener("click", () => {
  speak(reviewTest.list[reviewTest.index].word);
});
document.getElementById("rev-replay-btn").addEventListener("click", () => {
  speak(reviewTest.list[reviewTest.index].word);
});

document.getElementById("rev-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (reviewTest.answered) {
    advanceReview();
    return;
  }
  const item = reviewTest.list[reviewTest.index];
  const input = document.getElementById("rev-input");
  const guess = input.value.trim().toLowerCase();
  const correct = guess === item.word.toLowerCase();
  const elapsed = Date.now() - reviewTest.wordShownAt;

  const { priorAvg } = recordResult(item, correct, elapsed, guess);
  reviewTest.answered = true;
  input.disabled = true;
  reviewTest.records.push({ word: item.word, correct: correct, responseMs: elapsed, priorAvg: priorAvg });

  const note = correct ? speedNote(priorAvg, elapsed) : null;
  renderAnswerFeedback(document.getElementById("rev-feedback"), item, correct, guess, note);

  const isLast = reviewTest.index === reviewTest.list.length - 1;
  const nextBtn = document.getElementById("rev-next-btn");
  nextBtn.textContent = isLast ? "看結果 →" : "下一題 →";
  nextBtn.classList.remove("hidden");
});

document.getElementById("rev-next-btn").addEventListener("click", advanceReview);

function advanceReview() {
  if (reviewTest.index < reviewTest.list.length - 1) {
    reviewTest.index += 1;
    showReviewWord();
  } else {
    finishReview();
  }
}

function finishReview() {
  reviewTest.inProgress = false;
  document.getElementById("rev-progress-fill").style.width = "100%";
  document.getElementById("rev-body").classList.add("hidden");

  const records = reviewTest.records;
  const total = records.length;
  const correctCount = records.filter((r) => r.correct).length;
  const stillIncorrect = total - correctCount;
  const accuracy = total ? Math.round((correctCount / total) * 100) : 0;

  document.getElementById("rev-summary-score").textContent =
    `共複習 ${total} 題　答對 ${correctCount} 題　仍答錯 ${stillIncorrect} 題　複習正確率 ${accuracy}%`;

  // Response-time change: compare this round's elapsed time against each
  // word's own PRE-round baseline (priorAvg), for words that had one.
  const withBaseline = records.filter((r) => r.correct && r.priorAvg != null);
  let trendText = "尚無足夠的歷史資料可比較反應時間變化。";
  if (withBaseline.length) {
    const deltas = withBaseline.map((r) => r.priorAvg - r.responseMs); // positive = faster than before
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const improvedCount = deltas.filter((d) => d > 0).length;
    if (avgDelta > 0) {
      trendText = `本次答對的單字中，平均反應時間比之前快了約 ${Math.round(avgDelta)} 毫秒（${improvedCount}/${withBaseline.length} 個字進步）。`;
    } else {
      trendText = `本次答對的單字中，平均反應時間比之前慢了約 ${Math.round(-avgDelta)} 毫秒，可能需要再多練習幾次。`;
    }
  }
  document.getElementById("rev-summary-trend").textContent = trendText;

  const wordsDiv = document.getElementById("rev-summary-words");
  wordsDiv.innerHTML = "";
  const p = document.createElement("p");
  p.className = "hint";
  // A word's state updates the instant it's answered - answering an
  // incorrect word correctly here already moved it out of "incorrect"
  // (into "learning" or straight to "memorized" on a 2nd correct in a
  // row); no separate confirmation step is needed.
  p.textContent = "本回合複習的單字（點擊查看中文意思，答對的單字已自動更新狀態）：";
  wordsDiv.appendChild(p);
  const holder = document.createElement("div");
  wordsDiv.appendChild(holder);
  renderWordChipList(holder, reviewTest.list);

  document.getElementById("rev-summary").classList.remove("hidden");
}

document.getElementById("rev-again-btn").addEventListener("click", () => {
  document.getElementById("start-review-btn").click();
});
document.getElementById("rev-home-btn").addEventListener("click", () => showView("home"));

/* ---------- Review List (browsable Learning / Incorrect words) ---------- */

const REVIEWLIST_PAGE_SIZE = 20;
let reviewListSearch = "";
let reviewListIncorrectSort = "tries";
let reviewListLearningSort = "slow";
let reviewListIncorrectPage = 0;
let reviewListLearningPage = 0;

// Shared by both the Incorrect and Learning lists - not every mode is
// offered in both dropdowns, but the comparators are the same either way.
function sortReviewListItems(items, mode) {
  const arr = items.slice();
  switch (mode) {
    case "tries":
      // Most total attempts first - the words that keep coming up.
      arr.sort((a, b) => b.detail.attempts - a.detail.attempts);
      break;
    case "streak":
      arr.sort((a, b) => a.detail.correctStreak - b.detail.correctStreak);
      break;
    case "recent":
      arr.sort((a, b) => b.lastSeen - a.lastSeen);
      break;
    case "oldest":
      arr.sort((a, b) => a.lastSeen - b.lastSeen);
      break;
    case "az":
      arr.sort((a, b) => a.detail.word.localeCompare(b.detail.word));
      break;
    case "slow":
    default:
      // Slowest (relative to their own history) first, matching the same
      // "needs more practice" priority the Review Test uses; words with no
      // timing data yet sort last.
      arr.sort((a, b) => (b.detail.avgCorrectResponseMs ?? -1) - (a.detail.avgCorrectResponseMs ?? -1));
  }
  return arr;
}

function buildWordCard(detail, showWrongInfo) {
  const metaParts = showWrongInfo
    ? [`已作答 ${detail.attempts} 次`, `平均反應時間 ${formatMs(detail.avgCorrectResponseMs)}`]
    : [`連續正確 ${detail.correctStreak} / 2`, `平均反應時間 ${formatMs(detail.avgCorrectResponseMs)}`];

  return `
    <div class="word-card">
      <div class="word-card-main">
        <button type="button" class="card-play-btn" data-word="${escapeHtml(detail.word)}" title="播放發音">🔊</button>
        <span class="word-card-word">${escapeHtml(detail.word)}</span>
        <span class="muted">${escapeHtml(detail.pos || "")}</span>
        <span class="word-card-level">Level ${detail.level}</span>
        <button type="button" class="card-dict-btn" title="顯示／隱藏中文意思">📖</button>
      </div>
      <div class="word-card-meta muted">${metaParts.join("　・　")}</div>
      ${showWrongInfo ? `<div class="word-card-wrong">${renderWrongAnswerCell(detail)}</div>` : ""}
      <div class="row-zh hidden">${zhLines(detail.zh).map((l) => escapeHtml(l)).join("<br>")}</div>
    </div>`;
}

// With hundreds of words in a category, a flat unpaginated card list is
// unusable - this pages results (REVIEWLIST_PAGE_SIZE per page) and
// returns the (possibly clamped, e.g. after a search shrinks the result
// count) page number so the caller can keep its page-state variable in
// sync.
function renderReviewCategory(containerId, pagerContainerId, items, page, section, showWrongInfo, emptyText) {
  const container = document.getElementById(containerId);
  const pagerContainer = document.getElementById(pagerContainerId);
  if (!items.length) {
    container.innerHTML = `<p class="hint">${emptyText}</p>`;
    pagerContainer.innerHTML = "";
    return 0;
  }
  const totalPages = Math.max(1, Math.ceil(items.length / REVIEWLIST_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = clampedPage * REVIEWLIST_PAGE_SIZE;
  const shown = items.slice(start, start + REVIEWLIST_PAGE_SIZE);
  const cardsHtml = shown.map(({ detail }) => buildWordCard(detail, showWrongInfo)).join("");
  container.innerHTML = `<div class="word-card-list">${cardsHtml}</div>`;
  pagerContainer.innerHTML = buildPagerHtml(section, clampedPage, totalPages, items.length);
  return clampedPage;
}

function buildPagerHtml(section, page, totalPages, totalCount) {
  if (totalPages <= 1) return "";
  return `
    <div class="row pager">
      <button type="button" class="pager-btn" data-section="${section}" data-dir="-1" ${page <= 0 ? "disabled" : ""}>‹ 上一頁</button>
      <span class="muted">第 ${page + 1} / ${totalPages} 頁（共 ${totalCount} 筆）</span>
      <button type="button" class="pager-btn" data-section="${section}" data-dir="1" ${page >= totalPages - 1 ? "disabled" : ""}>下一頁 ›</button>
    </div>`;
}

function reviewListPool() {
  const levels = selectedLevels();
  return wordsForLevels(levels.length ? levels : [4, 5, 6]);
}

function renderReviewList() {
  const pool = reviewListPool();
  const cats = Logic.categorizeWords(pool, progressStore);
  const search = reviewListSearch.trim().toLowerCase();

  const toItems = (words) => words
    .filter((w) => !search || w.word.toLowerCase().includes(search))
    .map((w) => ({
      detail: Logic.computeWordDetail(w, progressStore),
      lastSeen: (progressStore[w.word.toLowerCase()] || {}).lastSeen || 0,
    }));

  const incorrectItems = sortReviewListItems(toItems(cats.incorrect), reviewListIncorrectSort);
  reviewListIncorrectPage = renderReviewCategory(
    "reviewlist-incorrect", "reviewlist-incorrect-pager", incorrectItems, reviewListIncorrectPage, "incorrect", true,
    search ? "沒有符合搜尋的答錯單字。" : "目前沒有答錯待複習的單字，太厲害了！"
  );
  document.getElementById("reviewlist-incorrect-count").textContent = incorrectItems.length;

  const learningItems = sortReviewListItems(toItems(cats.learning), reviewListLearningSort);
  reviewListLearningPage = renderReviewCategory(
    "reviewlist-learning", "reviewlist-learning-pager", learningItems, reviewListLearningPage, "learning", false,
    search ? "沒有符合搜尋的學習中單字。" : "目前沒有學習中的單字，去做幾回合單字測驗吧！"
  );
  document.getElementById("reviewlist-learning-count").textContent = learningItems.length;
}

document.getElementById("reviewlist-search").addEventListener("input", (e) => {
  reviewListSearch = e.target.value;
  reviewListIncorrectPage = 0;
  reviewListLearningPage = 0;
  renderReviewList();
});

document.getElementById("reviewlist-incorrect-sort").addEventListener("change", (e) => {
  reviewListIncorrectSort = e.target.value;
  reviewListIncorrectPage = 0;
  renderReviewList();
});

document.getElementById("reviewlist-learning-sort").addEventListener("change", (e) => {
  reviewListLearningSort = e.target.value;
  reviewListLearningPage = 0;
  renderReviewList();
});

// Delegated so it keeps working across re-renders: play a word's
// pronunciation, toggle its Chinese meaning open/closed, or page a list.
document.getElementById("view-reviewlist").addEventListener("click", (e) => {
  const playBtn = e.target.closest(".card-play-btn");
  if (playBtn) {
    speak(playBtn.dataset.word);
    return;
  }
  const dictBtn = e.target.closest(".card-dict-btn");
  if (dictBtn) {
    const zhDiv = dictBtn.closest(".word-card").querySelector(".row-zh");
    if (zhDiv) zhDiv.classList.toggle("hidden");
    return;
  }
  const pagerBtn = e.target.closest(".pager-btn");
  if (pagerBtn) {
    const dir = Number(pagerBtn.dataset.dir);
    if (pagerBtn.dataset.section === "incorrect") {
      reviewListIncorrectPage = Math.max(0, reviewListIncorrectPage + dir);
    } else {
      reviewListLearningPage = Math.max(0, reviewListLearningPage + dir);
    }
    renderReviewList();
  }
});

/* ---------- Progress view ---------- */

const STATE_LABELS = { new: "尚未測驗", incorrect: "答錯待複習", learning: "學習中", memorized: "已熟記" };

let progressFilter = "attempted";
let progressSearch = "";
let progressWordPage = 0;
// Same page size as the Review tab's own word-card pagination
// (REVIEWLIST_PAGE_SIZE) - a flat, unpaginated table was unusable once
// enough words had been attempted (up to 300 rows rendered at once,
// burying the sync/backup sections below it under a very long scroll).
const PROGRESS_WORD_PAGE_SIZE = REVIEWLIST_PAGE_SIZE;

document.getElementById("progress-filter-chips").addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-chip");
  if (!btn) return;
  progressFilter = btn.dataset.state;
  progressWordPage = 0;
  document.querySelectorAll("#progress-filter-chips .filter-chip").forEach((b) => {
    b.classList.toggle("active", b === btn);
  });
  renderWordTable();
});
document.getElementById("progress-search").addEventListener("input", (e) => {
  progressSearch = e.target.value;
  progressWordPage = 0;
  renderWordTable();
});
document.getElementById("progress-word-table-pager").addEventListener("click", (e) => {
  const pagerBtn = e.target.closest(".pager-btn");
  if (!pagerBtn) return;
  progressWordPage = Math.max(0, progressWordPage + Number(pagerBtn.dataset.dir));
  renderWordTable();
});

// Delegated (not per-row) so it keeps working across re-renders: play a
// word's pronunciation, or toggle its Chinese meaning open/closed, right
// from the Progress word table.
document.getElementById("progress-word-table").addEventListener("click", (e) => {
  const playBtn = e.target.closest(".row-play-btn");
  if (playBtn) {
    speak(playBtn.dataset.word);
    return;
  }
  const toggle = e.target.closest(".row-word-toggle");
  if (toggle) {
    const zhDiv = toggle.closest(".word-cell").querySelector(".row-zh");
    if (zhDiv) zhDiv.classList.toggle("hidden");
  }
});

function formatMs(ms) {
  return ms == null ? "—" : `${Math.round(ms)} ms`;
}

function formatPercent(x) {
  return x == null ? "—" : `${Math.round(x * 100)}%`;
}

function renderProgress() {
  const summary = Logic.computeProgressSummary(VOCAB, progressStore);

  document.getElementById("progress-grid").innerHTML = `
    <div class="stat-box"><span class="num">${summary.totalWords}</span><span class="label">總單字數</span></div>
    <div class="stat-box"><span class="num">${summary.totalEncountered}</span><span class="label">已練習過</span></div>
    <div class="stat-box"><span class="num">${summary.counts.memorized}</span><span class="label">已熟記</span></div>
    <div class="stat-box"><span class="num">${summary.counts.learning}</span><span class="label">學習中</span></div>
    <div class="stat-box"><span class="num">${summary.counts.incorrect}</span><span class="label">答錯待複習</span></div>
    <div class="stat-box"><span class="num">${formatPercent(summary.overallAccuracy)}</span><span class="label">整體正確率</span></div>
    <div class="stat-box"><span class="num">${formatPercent(summary.memorizationRate)}</span><span class="label">熟記率</span></div>
    <div class="stat-box"><span class="num">${formatPercent(summary.recentAccuracy)}</span><span class="label">近期正確率</span></div>
    <div class="stat-box"><span class="num">${formatMs(summary.globalAverageResponseMs)}</span><span class="label">平均反應時間</span></div>
  `;

  let trendText = "尚無足夠的作答紀錄可分析反應時間趨勢。";
  if (summary.recentAccuracy != null) {
    if (summary.responseTimeTrend > 0.05) trendText = "近期反應時間有變快的趨勢，代表越來越熟練。";
    else if (summary.responseTimeTrend < -0.05) trendText = "近期反應時間有變慢的趨勢，可能需要多複習。";
    else trendText = "近期反應時間大致穩定。";
  }
  document.getElementById("progress-trend-hint").textContent =
    `${trendText} 複習測驗會優先挑選比你「平均反應時間」慢的單字加強練習。`;

  const levelsHTML = [4, 5, 6]
    .map((lvl) => {
      const s = summary.byLevel[lvl] || { total: 0, new: 0, incorrect: 0, learning: 0, memorized: 0 };
      const total = s.total || 1;
      return `
        <div class="level-stat-row">
          <div class="level-stat-head"><span>Level ${lvl}</span><span>已熟記 ${s.memorized} / ${s.total}</span></div>
          <div class="level-stat-bar">
            <div class="seg seg-memorized" style="width:${(s.memorized / total) * 100}%"></div>
            <div class="seg seg-incorrect" style="width:${(s.incorrect / total) * 100}%"></div>
            <div class="seg seg-learning" style="width:${(s.learning / total) * 100}%"></div>
            <div class="seg seg-new" style="width:${(s.new / total) * 100}%"></div>
          </div>
        </div>`;
    })
    .join("");
  document.getElementById("progress-levels").innerHTML = levelsHTML;

  renderWordTable();
}

// Renders the correct spelling with the letters the user has NOT
// previously typed correctly (per the most recent mistake) highlighted,
// plus what they actually typed - so "wierd" vs "weird" visually shows
// the swapped letters instead of just two bare strings.
function renderWrongAnswerCell(detail) {
  if (!detail.lastWrongAnswer) return "—";
  const ops = Logic.diffChars(detail.lastWrongAnswer, detail.word);
  const correctHtml = ops
    .map((o) => (o.match ? escapeHtml(o.char) : `<span class="diff-miss">${escapeHtml(o.char)}</span>`))
    .join("");
  const title = detail.recentWrongAnswers.length
    ? `最近幾次打錯：${detail.recentWrongAnswers.join("、")}`
    : "";
  return `<span title="${escapeHtml(title)}">${correctHtml}<br><span class="muted">你打的：${escapeHtml(detail.lastWrongAnswer)}</span></span>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderWordTable() {
  const search = progressSearch.trim().toLowerCase();
  const details = [];
  for (const w of VOCAB) {
    const history = progressStore[w.word.toLowerCase()];
    const attempted = !!(history && history.attempts);
    if (progressFilter === "attempted" && !attempted) continue;
    if (progressFilter !== "all" && progressFilter !== "attempted") {
      const state = Logic.classifyState(history || {});
      if (state !== progressFilter) continue;
    }
    if (search && !w.word.toLowerCase().includes(search)) continue;
    details.push({ detail: Logic.computeWordDetail(w, progressStore), lastSeen: history ? history.lastSeen || 0 : 0 });
  }
  details.sort((a, b) => b.lastSeen - a.lastSeen);

  const container = document.getElementById("progress-word-table");
  const pagerContainer = document.getElementById("progress-word-table-pager");
  if (!details.length) {
    container.innerHTML = `<p class="hint">沒有符合條件的單字。</p>`;
    pagerContainer.innerHTML = "";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(details.length / PROGRESS_WORD_PAGE_SIZE));
  progressWordPage = Math.min(Math.max(0, progressWordPage), totalPages - 1);
  const start = progressWordPage * PROGRESS_WORD_PAGE_SIZE;
  const shown = details.slice(start, start + PROGRESS_WORD_PAGE_SIZE);
  const rows = shown
    .map(({ detail }) => `
      <tr>
        <td class="word-cell">
          <button type="button" class="row-play-btn" data-word="${escapeHtml(detail.word)}" title="播放發音">🔊</button>
          <span class="row-word-toggle" title="點擊顯示／隱藏中文意思">${escapeHtml(detail.word)}</span>
          <span class="muted">${escapeHtml(detail.pos || "")}</span>
          <div class="row-zh hidden">${zhLines(detail.zh).map((l) => escapeHtml(l)).join("<br>")}</div>
        </td>
        <td>${detail.level}</td>
        <td>${detail.correct} / ${detail.incorrect}</td>
        <td title="連續答對次數，答錯會歸零；連續 2 次才算已熟記">${detail.correctStreak}</td>
        <td>${formatMs(detail.avgCorrectResponseMs)}</td>
        <td>${renderWrongAnswerCell(detail)}</td>
        <td><span class="state-badge ${detail.state}">${STATE_LABELS[detail.state]}</span></td>
      </tr>`)
    .join("");

  container.innerHTML = `
    <p class="hint">連續答對 2 次即為「已熟記」，答錯一次就會重新歸零並回到「答錯待複習」。複習測驗會依你的平均反應時間，優先挑選比較慢、比較久沒複習的單字。滑鼠移到「最近錯誤」欄可看更多次錯誤紀錄。</p>
    <div class="word-table-wrap">
      <table class="word-table">
        <thead><tr><th>單字</th><th>等級</th><th>對／錯</th><th title="連續答對次數">連續正確</th><th>平均反應時間</th><th>最近錯誤</th><th>狀態</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  pagerContainer.innerHTML = buildPagerHtml("progress-word", progressWordPage, totalPages, details.length);
}

/* ---------- Backup / restore (export-to-file, temporary stand-in until
   there's a real account-synced backend) ---------- */

// Schema is intentionally simple and self-describing (not just a raw dump
// of localStorage) so a future migration script can read old export files
// without having to reverse-engineer today's internal shape.
const EXPORT_SCHEMA_VERSION = 1;

function showImportStatus(text, isError) {
  const el = document.getElementById("import-status");
  el.textContent = text;
  el.classList.remove("hidden");
  el.classList.toggle("danger-text", !!isError);
}

document.getElementById("export-progress-btn").addEventListener("click", () => {
  const payload = {
    source: "vocab-tool-local-export",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    progress: progressStore,
    settings: settings,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vocab-progress-${dateStamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showImportStatus(`已匯出備份檔（共 ${Object.keys(progressStore).length} 個單字的紀錄）。`, false);
});

document.getElementById("import-progress-btn").addEventListener("click", () => {
  document.getElementById("import-progress-file").click();
});

document.getElementById("import-progress-file").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // allow re-selecting the same file later
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (err) {
      showImportStatus("匯入失敗：這不是有效的 JSON 備份檔。", true);
      return;
    }
    const importedProgress = parsed && typeof parsed === "object" ? parsed.progress : null;
    if (!importedProgress || typeof importedProgress !== "object") {
      showImportStatus("匯入失敗：檔案格式不正確（找不到學習紀錄內容）。", true);
      return;
    }

    const wordCount = Object.keys(importedProgress).length;
    const confirmed = confirm(
      `即將匯入備份檔（${wordCount} 個單字的紀錄${parsed.exportedAt ? `，匯出於 ${parsed.exportedAt.slice(0, 10)}` : ""}）。\n\n` +
      "這會「取代」目前這台裝置瀏覽器裡的全部學習紀錄，無法復原，確定要繼續嗎？"
    );
    if (!confirmed) return;

    // Re-migrate on the way in too, in case the backup predates a later
    // schema change - same safety net as loading from localStorage.
    progressStore = Logic.migrateProgressStore(importedProgress, VOCAB_INDEX);
    if (parsed.settings && typeof parsed.settings === "object") {
      settings = Object.assign({}, settings, parsed.settings);
      saveSettings();
      applySettingsToUI();
    }
    saveProgress();
    renderProgress();
    showImportStatus(`已匯入 ${wordCount} 個單字的學習紀錄。`, false);
  };
  reader.onerror = () => showImportStatus("匯入失敗：無法讀取檔案。", true);
  reader.readAsText(file);
});

document.getElementById("reset-progress-btn").addEventListener("click", () => {
  if (confirm("確定要清除全部學習紀錄嗎？此動作無法復原。")) {
    progressStore = {};
    saveProgress();
    renderProgress();
  }
});

/* ---------- Check for updates ---------- */

const JUST_UPDATED_KEY = "vocab_just_updated";

function showUpdateToast(text) {
  const toast = document.getElementById("update-toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 4000);
}

// Removes the one-time cache-busting query param a forced reload adds,
// so it doesn't linger in the address bar.
function stripHardRefreshParam() {
  if (location.search.includes("hardrefresh=")) {
    history.replaceState(null, "", location.pathname);
  }
}

async function checkForUpdate() {
  const btn = document.getElementById("update-check-btn");
  const statusEl = document.getElementById("update-status");
  btn.disabled = true;
  statusEl.className = "update-status";
  statusEl.textContent = "檢查中...";

  try {
    // cache: "no-store" plus a one-off query string defeats both the
    // browser cache and GitHub Pages' CDN cache, so this always reflects
    // whatever was most recently deployed - not a cached copy.
    const res = await fetch(`app.js?check=${Date.now()}`, { cache: "no-store" });
    const text = await res.text();
    const match = text.match(/const APP_VERSION = "([^"]*)"/);
    const remoteVersion = match ? match[1] : null;

    // A real stamped version is always an 8-char git short SHA. Anything
    // else means this copy (local or remote) wasn't built by the deploy
    // workflow - e.g. local dev, where the __BUILD_VERSION__ placeholder
    // is never substituted. Note: that placeholder token itself must not
    // appear literally in this comparison, since the CI step's sed command
    // replaces every occurrence of it in this file, including here.
    const isRealVersion = (v) => typeof v === "string" && /^[0-9a-f]{8}$/.test(v);

    if (!isRealVersion(remoteVersion) || !isRealVersion(APP_VERSION) || remoteVersion === APP_VERSION) {
      statusEl.classList.add("up-to-date");
      statusEl.textContent = "✅ 目前已是最新版本";
      btn.disabled = false;
    } else {
      statusEl.classList.add("updating");
      statusEl.textContent = "🔄 發現新版本，正在重新整理...";
      sessionStorage.setItem(JUST_UPDATED_KEY, remoteVersion);
      // A stale service worker cache (see sw.js) is exactly what would
      // otherwise make this "found a new version" reload land right back
      // on the OLD app shell - clear it (and nudge the registration to
      // re-check sw.js itself) before reloading, same reasoning as
      // Orbit's own force-update flow. Fire-and-forget: the setTimeout
      // below reloads regardless, so a slow/stuck cache API never leaves
      // this button just sitting there looking broken.
      if ("caches" in window) {
        caches
          .keys()
          .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
          .catch(() => {});
      }
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .getRegistration()
          .then((reg) => (reg ? reg.update() : null))
          .catch(() => {});
      }
      setTimeout(() => {
        // A brand-new query string on the page itself is a guaranteed
        // cache miss, so this reload always fetches the fresh index.html
        // (and, through it, the fresh app.js/style.css/vocab.json).
        window.location.href = `${location.pathname}?hardrefresh=${Date.now()}`;
      }, 600);
    }
  } catch (e) {
    statusEl.classList.add("error");
    statusEl.textContent = "⚠️ 檢查失敗，請確認網路連線";
    btn.disabled = false;
  }
}

document.getElementById("update-check-btn").addEventListener("click", checkForUpdate);

/* ---------- Init ---------- */

async function init() {
  stripHardRefreshParam();
  const justUpdated = sessionStorage.getItem(JUST_UPDATED_KEY);
  if (justUpdated) {
    sessionStorage.removeItem(JUST_UPDATED_KEY);
    showUpdateToast(`✅ 已更新到最新版本（${justUpdated}）`);
  }

  await loadVocab();
  updateLevelHint();
  applySettingsToUI();

  if (window.speechSynthesis) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  // Sync (see sync.js) must not pull-and-apply a remote snapshot until
  // VOCAB_INDEX exists to migrate it against (see
  // window.VocabState.applySyncedSnapshot above) - loadVocab() just
  // finished building it, so this is the first safe moment to let sync.js
  // start its own activity/visibility-driven loop.
  if (window.VocabSync) window.VocabSync.onVocabReady();

  // Makes "加到主畫面" installs work and the app usable offline after a
  // first visit (see sw.js). `updateViaCache: 'none'` stops the browser's
  // own HTTP cache from ever serving a stale sw.js itself - this file is
  // the one thing that must always be fetched fresh so a real update is
  // never stuck behind a cached copy of the worker that would otherwise
  // keep re-installing the old one.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }
}

init();
