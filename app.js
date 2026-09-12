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
// The three question-type categories the home screen's ratio sliders
// control (see setWordRatio) - order also doubles as fallback priority
// when passed straight through to Logic.selectQuestions's own ratio.
const RATIO_KEYS = ["new", "incorrect", "learning"];

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
// wordRatio: percentages (0-100, summing to 100) of new/incorrect/learning
// words in a round's question mix - see the home screen's three sliders
// and setWordRatio below. Defaults to the old Vocabulary Test's 80/10/10
// split; a user who wants the old Review Test's 70/30 (no new words) shape
// just drags the sliders there (or taps the matching preset button) - one
// mode, one adjustable mix, instead of two fixed modes to pick between.
// mode: which of the four home-screen "測驗模式" options picks the
// question-type ratio for a round - "auto" (default) re-derives it live
// from current word counts (see currentModeRatioFraction), "new"/"review"
// are the old fixed 80/10/10 and 0/70/30 presets, and "advanced" is the
// user's own custom wordRatio sliders below.
let settings = Object.assign(
  { levels: [4, 5, 6], rate: 0.9, testMinutes: 10, mode: "auto", wordRatio: { new: 80, incorrect: 10, learning: 10 } },
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
  document.getElementById("test-minutes").value = String(settings.testMinutes);
  document.getElementById("test-minutes-value").textContent = `${settings.testMinutes} 分鐘`;
  RATIO_KEYS.forEach((key) => {
    const value = settings.wordRatio[key];
    document.getElementById(`ratio-${key}`).value = String(value);
    document.getElementById(`ratio-${key}-value`).textContent = `${value}%`;
  });
  applyModeToUI();
}

// Reflects settings.mode onto the four mode-chip radios (and their
// "selected" outline, for browsers without :has() support), shows/hides
// the advanced ratio-slider panel, and refreshes the auto-mode live
// preview hint.
function applyModeToUI() {
  document.querySelectorAll('#mode-picker input[name="test-mode"]').forEach((el) => {
    const checked = el.value === settings.mode;
    el.checked = checked;
    el.closest(".mode-chip").classList.toggle("selected", checked);
  });
  document.getElementById("ratio-advanced-panel").classList.toggle("hidden", settings.mode !== "advanced");
  updateAutoRatioHint();
}

// Live preview of what "auto" mode would currently pick, so the effect of
// switching level checkboxes / practicing a round is visible on the home
// screen itself, not just once a round starts. A no-op (blank) outside
// auto mode or before vocab has loaded.
function updateAutoRatioHint() {
  const hintEl = document.getElementById("auto-ratio-hint");
  if (!hintEl) return;
  if (settings.mode !== "auto" || !VOCAB.length) {
    hintEl.textContent = "";
    return;
  }
  const levels = selectedLevels();
  const pool = wordsForLevels(levels.length ? levels : [4, 5, 6]);
  const ratio = Logic.computeAutoBalanceRatioForPool(pool, progressStore);
  hintEl.textContent =
    `目前配比：新字 ${Math.round(ratio.new * 100)}%・答錯 ${Math.round(ratio.incorrect * 100)}%・學習中 ${Math.round(ratio.learning * 100)}%`;
}

document.getElementById("mode-picker").addEventListener("change", (e) => {
  const radio = e.target.closest('input[name="test-mode"]');
  if (!radio) return;
  settings.mode = radio.value;
  applyModeToUI();
  saveSettings();
});

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

// Every 20th answer within a single running session (test or review, they
// share this counter since they share recordResult) forces an immediate
// sync round trip instead of waiting for the ordinary activity throttle
// (see sync.js's ACTIVITY_SYNC_THROTTLE_MS) - a long round (a 30-minute
// timed test can easily run past a couple hundred questions) otherwise
// only actually syncs once every 5 seconds' worth of throttled activity
// checks, which is fine for keeping the SERVER copy warm but leaves a
// bigger and bigger chunk of a long round's progress sitting unpushed if
// the tab crashes or the device loses power mid-round. This is a
// deliberately simple period, not tied to elapsed time or word count
// precision - just "don't let more than ~20 answers pile up unpushed."
const FORCE_SYNC_EVERY_N_ANSWERS = 20;
let answersSinceForcedSync = 0;

// Fetches (creating if needed) the history entry for a vocab item and
// records one answer into it. `answer` is the exact text the user typed -
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
  answersSinceForcedSync += 1;
  if (answersSinceForcedSync >= FORCE_SYNC_EVERY_N_ANSWERS) {
    answersSinceForcedSync = 0;
    if (window.VocabSync) window.VocabSync.syncNow();
  }
  return { history: history, priorAvg: priorAvg };
}

/* ---------- Custom confirm dialog ---------- */

// Replaces the browser's native confirm() everywhere in this app (and, via
// window.VocabUI below, in sync.js too) - the native one renders as
// unstyled OS chrome that looks out of place next to the rest of the UI,
// and on an iOS Home Screen-installed PWA in particular can be mistaken
// for a system prompt rather than something this page is asking. Backed by
// the #modal-overlay markup in index.html; resolves true/false rather than
// blocking the whole page the way window.confirm() does, so every call
// site awaits it instead.
let modalDialogOpen = false;
function showConfirmDialog(message, opts) {
  // Guards against a second confirm firing (e.g. a rapid double-tap on two
  // different tabs) while one is already showing - window.confirm() was
  // immune to this for free by blocking the whole page; this dialog isn't,
  // so any overlapping call is simply declined rather than fighting the
  // first dialog for the same DOM elements.
  if (modalDialogOpen) return Promise.resolve(false);
  modalDialogOpen = true;
  const options = opts || {};
  return new Promise((resolve) => {
    const overlay = document.getElementById("modal-overlay");
    const messageEl = document.getElementById("modal-message");
    const okBtn = document.getElementById("modal-ok-btn");
    const cancelBtn = document.getElementById("modal-cancel-btn");

    messageEl.innerHTML = "";
    String(message)
      .split("\n")
      .forEach((line) => {
        const p = document.createElement("p");
        p.textContent = line; // may be an empty string, fine as a spacer paragraph
        messageEl.appendChild(p);
      });

    okBtn.textContent = options.confirmText || "確定";
    okBtn.className = `btn ${options.danger ? "danger" : "primary"}`;
    cancelBtn.textContent = options.cancelText || "取消";
    cancelBtn.classList.toggle("hidden", !!options.hideCancel);

    function cleanup(result) {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onOverlayMousedown);
      document.removeEventListener("keydown", onKeydown);
      modalDialogOpen = false;
      resolve(result);
    }
    function onOk() {
      cleanup(true);
    }
    function onCancel() {
      cleanup(false);
    }
    // mousedown (not click) so a drag/select that starts inside the box and
    // ends up released outside it doesn't get misread as a backdrop tap.
    function onOverlayMousedown(e) {
      if (e.target === overlay) cleanup(false);
    }
    function onKeydown(e) {
      if (e.key === "Escape") cleanup(false);
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onOverlayMousedown);
    document.addEventListener("keydown", onKeydown);

    overlay.classList.remove("hidden");
    okBtn.focus();
  });
}

// The seam sync.js's own confirm prompts use (join/unlink/delete/restore-
// backup) - same reasoning as window.VocabState/window.VocabSync: one
// small cross-file surface instead of sync.js reaching into app.js's DOM
// helpers directly.
window.VocabUI = {
  confirm: showConfirmDialog,
};

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
  //
  // persistProgress(), NOT saveProgress(): this runs on EVERY load, whether
  // or not migration actually changed anything, so it must never be treated
  // as "the user made a change, push it" (see saveProgress's own
  // notifyLocalChange call) - that previously marked a fresh page load
  // dirty before sync.js had pulled even once, so the very first sync tick
  // of the session saw dirty=true and PUSHED this device's local data over
  // whatever newer data another device had already published, instead of
  // pulling it down. A real local edit (an answer, an import, a reset)
  // still calls saveProgress() itself and is still pushed normally.
  progressStore = Logic.migrateProgressStore(progressStore, VOCAB_INDEX);
  persistProgress();
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
let speakRequestId = 0;
// Set the moment the page is backgrounded (see the visibilitychange/
// pagehide listeners below), cleared once getAudioContext() has rebuilt a
// fresh context after it. Closing (see the "closed" check below) only
// catches the case where iOS is honest about having killed the context -
// in practice, backgrounding a Home Screen-installed PWA for "long enough"
// (inconsistent - sometimes seconds, sometimes longer, seemingly tied to
// memory pressure/how many other apps got switched through) can leave the
// context reporting a perfectly ordinary "suspended" state that then never
// actually completes resume() no matter how many times it's called -
// effectively dead, but without ever announcing it. There's no reliable
// way to detect that from the state alone, so instead: ANY time the page
// was hidden at all, throw the context away and build a completely fresh
// one on the next real gesture, rather than gambling on whether resuming
// the old one will actually work this time.
let audioCtxStaleFromBackground = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") audioCtxStaleFromBackground = true;
});
window.addEventListener("pagehide", () => {
  audioCtxStaleFromBackground = true;
});

function getAudioContext() {
  if (audioCtx && (audioCtxStaleFromBackground || audioCtx.state === "closed")) {
    // close() always returns a Promise (never throws synchronously) that
    // REJECTS if the context is already closed - catch that explicitly
    // rather than relying on a synchronous try/catch, which does nothing
    // for a rejection that surfaces later as an unhandled promise
    // rejection instead of a thrown exception.
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (!audioCtx) {
    // iOS Safari doesn't just SUSPEND the AudioContext when a Home
    // Screen-installed PWA is backgrounded (app-switcher swipe away) - it
    // can fully CLOSE it to reclaim the audio hardware for whatever's now
    // in the foreground, or leave it in a state that LOOKS suspended but
    // can never actually resume (see audioCtxStaleFromBackground's own
    // comment above) - a fresh context here recovers from either.
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    audioCtxStaleFromBackground = false;
  }
  // Covers both the ordinary "suspended until a user gesture resumes it"
  // state and iOS Safari's own "interrupted" state (a Safari-specific
  // extension for a lesser interruption than a full close, e.g. a phone
  // call) - resume() is a safe no-op if already running. Calling this
  // synchronously at the top of speak() (itself always called from a
  // click/submit/keydown handler) - or, for start-test-btn, synchronously
  // at the very top of its own click handler - keeps the resume() call
  // itself inside the user gesture even though playback may not actually
  // start until later.
  if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
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

// Each call gets its own id, checked again once its buffer is ready -
// without this, two speak() calls close together (next word shown right
// after a slow replay tap, or vice versa) could resolve out of order: the
// OLDER call's fetch/decode finishing after the newer one's already started
// playing would then overwrite currentSource and start itself on top of/
// after the correct audio, which could easily look like "sometimes audio
// doesn't play" (the right word's audio getting cut off or never actually
// heard). Whichever call was requested LAST always wins now, regardless of
// which one's promise resolves last.
function speak(word) {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  // Called here (synchronously, unlocking/rebuilding the context if it was
  // suspended or closed - see getAudioContext()'s own comment) AND again
  // below once the buffer is actually ready, rather than trusting this one
  // reference for the whole async chain: if the app gets backgrounded and
  // iOS closes the context WHILE a fetch/decode is still in flight, this
  // captured `ctx` would be a dead object by the time playback tries to
  // start on it. Re-checking via getAudioContext() again below is cheap
  // (it's just a state check in the common case) and guarantees whatever
  // actually calls createBufferSource() is never a stale closed context.
  getAudioContext();
  const requestId = ++speakRequestId;
  if (currentSource) {
    try {
      currentSource.stop();
    } catch (e) {
      /* already stopped/finished - fine to ignore */
    }
    currentSource = null;
  }

  loadAudioBuffer(word)
    .then(async (buffer) => {
      if (requestId !== speakRequestId) return; // superseded by a newer speak() call
      let ctx = getAudioContext();
      if (ctx.state !== "running") {
        // Starting a buffer source while the context isn't running yet can
        // silently drop the audio on some browsers instead of queuing it -
        // wait for the resume already kicked off in getAudioContext() (or
        // kick/await one now) before actually starting playback.
        try {
          await ctx.resume();
        } catch (e) {
          /* ignore - source.start below still no-ops safely if this never resolves */
        }
        if (requestId !== speakRequestId) return; // re-check: the await above may have taken a moment
        ctx = getAudioContext(); // re-fetch once more in case the await above outlived a close+rebuild
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = settings.rate;
      source.connect(ctx.destination);
      currentSource = source;
      source.start(0);
    })
    .catch(() => {
      if (requestId !== speakRequestId) return;
      speakWithWebSpeech(word);
    });
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

// Leaving the Vocabulary Test view via a tab click used to silently PAUSE
// an unfinished round (vocabTest.inProgress stayed true) rather than end
// it - the round was still sitting there, built from whatever level
// checkboxes were checked back when it started. Clicking "開始測驗" again
// just resumed that same stale round (see that button's own handler below:
// `if (vocabTest.inProgress) { showView(...); return; }` skips rebuilding
// the list entirely), even after changing the level checkboxes - which
// looked exactly like "the test always picks Level 4" whenever an earlier
// round happened to start Level-4-only and got abandoned via a tab click
// instead of actually finished. Tab-clicking away from an unfinished round
// now requires confirming, and confirming ends the round for real (not
// just hides it) so the level checkboxes are honored next time.
function isLeavingActiveRound() {
  const activeView = document.querySelector(".view.active");
  return !!activeView && activeView.id === "view-test" && vocabTest.inProgress;
}

document.getElementById("tabs").addEventListener("click", async (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  if (isLeavingActiveRound()) {
    const confirmed = await showConfirmDialog(
      "測驗還沒完成，確定要離開嗎？\n\n離開後這一回合會結束，下次按「開始測驗」會開始新的一回合（不會保留繼續作答）。",
      { confirmText: "離開", danger: true }
    );
    if (!confirmed) return;
    vocabTest.inProgress = false;
    stopRoundTimer();
  }
  showView(btn.dataset.view);
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
  updateAutoRatioHint();
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

function setTestMinutes(minutes) {
  const clamped = Math.min(30, Math.max(2, Math.round(minutes) || 2));
  settings.testMinutes = clamped;
  document.getElementById("test-minutes").value = String(clamped);
  document.getElementById("test-minutes-value").textContent = `${clamped} 分鐘`;
  saveSettings();
}

document.getElementById("test-minutes").addEventListener("input", (e) => {
  setTestMinutes(Number(e.target.value));
});

document.getElementById("test-minutes-presets").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-minutes]");
  if (!btn) return;
  setTestMinutes(Number(btn.dataset.minutes));
});

// Keeps the three ratio sliders always summing to exactly 100%, the way a
// "budget allocation" control conventionally works: dragging one to
// `newValue` takes the rest of the 100% away from (or gives it back to)
// the OTHER two, split between them in proportion to their current values
// (evenly if both are currently 0) - never a fourth silent "leftover"
// category. The last key in RATIO_KEYS order always gets the exact
// remainder rather than its own rounded share, so the three integers add
// up to precisely 100 every time, not just approximately.
function setWordRatio(changedKey, rawValue) {
  const newValue = Math.max(0, Math.min(100, Math.round(rawValue) || 0));
  const current = settings.wordRatio;
  const others = RATIO_KEYS.filter((k) => k !== changedKey);
  const othersCurrentSum = others.reduce((sum, k) => sum + current[k], 0);
  const remaining = 100 - newValue;

  const next = {};
  next[changedKey] = newValue;
  let assignedToOthers = 0;
  others.forEach((key, i) => {
    if (i === others.length - 1) {
      next[key] = Math.max(0, remaining - assignedToOthers);
      return;
    }
    const share = othersCurrentSum > 0
      ? Math.round((current[key] / othersCurrentSum) * remaining)
      : Math.round(remaining / others.length);
    next[key] = Math.max(0, Math.min(remaining - assignedToOthers, share));
    assignedToOthers += next[key];
  });

  settings.wordRatio = next;
  RATIO_KEYS.forEach((key) => {
    document.getElementById(`ratio-${key}`).value = String(next[key]);
    document.getElementById(`ratio-${key}-value`).textContent = `${next[key]}%`;
  });
  saveSettings();
}

RATIO_KEYS.forEach((key) => {
  document.getElementById(`ratio-${key}`).addEventListener("input", (e) => {
    setWordRatio(key, Number(e.target.value));
  });
});

document.getElementById("ratio-presets").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-ratio]");
  if (!btn) return;
  const [newPct, incorrectPct, learningPct] = btn.dataset.ratio.split(",").map(Number);
  settings.wordRatio = { new: newPct, incorrect: incorrectPct, learning: learningPct };
  applySettingsToUI();
  saveSettings();
});

/* ---------- Shared quiz mechanics ---------- */

// mm:ss, capped at 0 rather than going negative - used for the time-boxed
// round's remaining-time display (see startRoundTimer below).
function formatMMSS(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// A round is time-boxed (see settings.testMinutes), not question-counted,
// since we already record every answer's actual response time - there's no
// need to make the user guess how many questions fit in the time they
// have. The question LIST built at round start is still sized generously
// (the full available pool - see start-test-btn below) so it never runs
// out before the clock does; the clock, not the list length, is what ends
// the round.
//
// Ticks the visible countdown every second while a round is active - not
// just when a new question is shown - so the display doesn't sit stale
// while the user is still thinking about/typing the current word. Started
// fresh (stopRoundTimer, then restarted) each time a round begins, stopped
// by finishTest when a round ends normally, and by the tabs click handler
// above when a round is abandoned mid-way (see isLeavingActiveRound) - that
// path doesn't call finishTest (no summary screen to show for an abandoned
// round), so it stops the timer directly instead.
let roundTimerHandle = null;
function startRoundTimer(tickFn) {
  stopRoundTimer();
  tickFn();
  roundTimerHandle = setInterval(tickFn, 1000);
}
function stopRoundTimer() {
  if (roundTimerHandle) {
    clearInterval(roundTimerHandle);
    roundTimerHandle = null;
  }
}

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

// `state` is the word's classifyState() result AFTER this attempt was
// recorded - only meaningful/shown when correct (a wrong answer always
// classifies as "incorrect", which isn't worth a badge here since the
// feedback is already very visibly marked wrong).
function renderAnswerFeedback(feedbackEl, item, correct, guess, note, state) {
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

  if (!correct) {
    // Same letter-by-letter diff shown in Progress/複習 (see
    // renderWrongAnswerCell/buildDiffHtml) - surfaced immediately after
    // this answer too, not just later when browsing those tabs, so a
    // mistake pattern (a swapped letter, a missing double letter) is
    // visible right when it happens.
    const diffEl = document.createElement("div");
    diffEl.className = "answer-diff";
    diffEl.innerHTML = `拼法對照：${buildDiffHtml(guess, item.word)}`;
    feedbackEl.appendChild(diffEl);
  }

  if (note) {
    const noteEl = document.createElement("div");
    noteEl.className = `speed-note ${note.cls}`;
    noteEl.textContent = note.text;
    feedbackEl.appendChild(noteEl);
  }

  if (correct && (state === "learning" || state === "memorized")) {
    const stateEl = document.createElement("span");
    stateEl.className = `state-badge ${state} answer-state`;
    stateEl.textContent = STATE_LABELS[state];
    feedbackEl.appendChild(stateEl);
  }
}

/* ---------- Vocabulary Test mode ---------- */

const vocabTest = {
  list: [],
  pool: [], // the full level-filtered word pool this round was built from - see rebalanceAutoModeTail
  index: 0,
  answeredCount: 0,
  correctCount: 0,
  missed: [],
  answered: false,
  wordShownAt: 0,
  startedAt: 0,
  timeLimitMs: 0,
  inProgress: false,
  // true only for a round started from 複習's "測驗這些單字" (see
  // startReviewDeckTest) - a fixed, user-chosen word set, not the
  // ratio-driven pool the home screen's modes build from. Answers still
  // record normally (recordResult doesn't check this at all - reviewing a
  // word here is exactly as real as reviewing it anywhere else), this only
  // suppresses auto mode's mid-round rebalancing (see rebalanceAutoModeTail),
  // which has no ratio/pool of its own to rebalance against here.
  customDeck: false,
};

// Fetches (and caches - see loadAudioBuffer) the audio for whatever word
// comes right after the one currently on screen, so it's already decoded
// and ready by the time the user gets there instead of only starting the
// fetch/decode at the moment speak() is called for it. Called both when a
// question is first shown and again after any mid-round rebalance (auto
// mode can change which word is "next" - see rebalanceAutoModeTail), so
// the preload always targets whichever word will actually be asked next.
function preloadNextAudio() {
  const next = vocabTest.list[vocabTest.index + 1];
  if (next) loadAudioBuffer(next.word).catch(() => {});
}

// Auto mode's live re-balancing: re-derives the new/incorrect/learning
// ratio from the CURRENT word counts (an answer just recorded may have
// moved a word between categories - e.g. an incorrect word graduating to
// learning) and rebuilds the not-yet-reached tail of the round with it,
// exactly like the sync-reconcile tail-rebuild above but triggered by
// every single answer instead of only an external sync pull. Everything
// already presented (up to and including the current word) is left
// completely alone - only what comes after is subject to change - so
// results already shown/recorded are never altered, only what's asked next.
function rebalanceAutoModeTail() {
  if (settings.mode !== "auto" || !vocabTest.inProgress || vocabTest.customDeck) return;
  const pool = vocabTest.pool;
  if (!pool || !pool.length) return;
  const presented = new Set(vocabTest.list.slice(0, vocabTest.index + 1).map((w) => w.word.toLowerCase()));
  const ratio = Logic.computeAutoBalanceRatioForPool(pool, progressStore);
  const freshTail = Logic.selectQuestions({
    pool: pool,
    historyStore: progressStore,
    size: pool.length,
    ratio: ratio,
  }).filter((w) => !presented.has(w.word.toLowerCase()));
  vocabTest.list = vocabTest.list.slice(0, vocabTest.index + 1).concat(freshTail);
  preloadNextAudio();
}

// A customDeck round (see startReviewDeckTest) is never time-boxed - it
// exists to test exactly the words just reviewed, so it ends when every one
// of THOSE has been gone through, not when a clock runs out. Short-circuiting
// here is the one change needed to get that: advanceTest()/the submit
// handler's "is this the last question" check both already fall through to
// "index reached the end of the list" once this can never be true.
function testTimeUp() {
  if (vocabTest.customDeck) return false;
  return Date.now() - vocabTest.startedAt >= vocabTest.timeLimitMs;
}
function updateTestTimeDisplay() {
  const elapsedMs = Date.now() - vocabTest.startedAt;
  document.getElementById("test-progress-text").textContent = formatMMSS(vocabTest.timeLimitMs - elapsedMs);
  document.getElementById("test-progress-fill").style.width = `${Math.min(100, (elapsedMs / vocabTest.timeLimitMs) * 100)}%`;
}
// A customDeck round shows "第 X / Y 題" and a fill proportional to
// progress through the list instead of a countdown clock - there is no
// clock. Used everywhere updateTestTimeDisplay used to be called
// unconditionally.
function updateTestProgressDisplay() {
  if (!vocabTest.customDeck) {
    updateTestTimeDisplay();
    return;
  }
  const total = vocabTest.list.length;
  const current = Math.min(vocabTest.index + 1, total);
  document.getElementById("test-progress-text").textContent = `第 ${current} / ${total} 題`;
  document.getElementById("test-progress-fill").style.width = `${total ? (current / total) * 100 : 0}%`;
}

// The Vocabulary Test view has no top-level tab of its own - it's only
// ever entered from this button, and navigating away mid-round (e.g. to
// check Progress) and back must resume exactly where it left off rather
// than silently discarding the round. The underlying view stays in the
// DOM (just hidden via CSS) while inactive, so simply re-showing it is
// enough to restore its on-screen state; only a *finished* round (or no
// round at all yet) should build a fresh one.
// Converts settings.wordRatio (0-100 integers summing to 100, the shape
// the sliders edit directly) to the 0..1 fractions Logic.selectQuestions
// expects - only used by the "advanced" mode (see currentModeRatioFraction).
function currentAdvancedRatioFraction() {
  return {
    new: settings.wordRatio.new / 100,
    incorrect: settings.wordRatio.incorrect / 100,
    learning: settings.wordRatio.learning / 100,
  };
}

// Fixed presets for the "new" (mostly new words) and "review" (no new
// words) mode chips - the same two ratios the old two-preset buttons used
// to set the sliders to, now available directly as modes so most users
// never need to touch the advanced sliders at all.
const FIXED_MODE_RATIOS = {
  new: { new: 0.8, incorrect: 0.1, learning: 0.1 },
  review: { new: 0, incorrect: 0.7, learning: 0.3 },
};

// The one place that turns settings.mode into the actual ratio passed to
// Logic.selectQuestions - "auto" is the only mode that depends on `pool`
// (it re-derives the ratio from current word counts every time it's
// called, which is what lets it be re-evaluated live mid-round; see
// rebalanceAutoModeTail).
function currentModeRatioFraction(pool) {
  if (settings.mode === "new" || settings.mode === "review") return FIXED_MODE_RATIOS[settings.mode];
  if (settings.mode === "advanced") return currentAdvancedRatioFraction();
  return Logic.computeAutoBalanceRatioForPool(pool, progressStore);
}

document.getElementById("start-test-btn").addEventListener("click", () => {
  if (vocabTest.inProgress) {
    showView("test");
    return;
  }
  const levels = selectedLevels();
  if (!levels.length) return;
  // Everything through showTestWord() below runs SYNCHRONOUSLY, inside
  // this click's own call stack - no `await` anywhere before it. Both the
  // AudioContext unlock (see getAudioContext()'s comment) and the mobile
  // on-screen keyboard opening (input.focus() inside showTestWord) require
  // browsers like iOS Safari to see them called directly from a trusted
  // user gesture; an earlier version of this handler awaited a sync
  // reconcile before reaching either one, which silently broke both -
  // audio went silent and the keyboard stopped auto-opening. The reconcile
  // below still happens, just AFTER the round is already visibly running,
  // never blocking it.
  getAudioContext();
  const pool = wordsForLevels(levels);
  vocabTest.pool = pool; // kept for live re-rebalancing mid-round in auto mode (see rebalanceAutoModeTail)
  vocabTest.customDeck = false;
  const ratio = currentModeRatioFraction(pool);
  // The round is time-boxed (settings.testMinutes), not question-counted -
  // request the WHOLE available pool up front so the list never runs out
  // before the clock does (selectQuestions can't return more than
  // pool.length distinct words anyway, so this is never wasteful, just
  // generous). testTimeUp()/advanceTest() below are what actually end the
  // round.
  vocabTest.list = Logic.selectQuestions({ pool: pool, historyStore: progressStore, size: pool.length, ratio: ratio });
  document.getElementById("test-summary").classList.add("hidden");
  // The chosen levels + ratio can genuinely come up empty (e.g. sliders set
  // to 100% incorrect/待複習 but nothing is currently marked incorrect) -
  // showTestWord() below indexes into an empty list otherwise, so this has
  // to be checked before touching any round state. Shows the same view the
  // round itself would (no separate screen to navigate through), with a
  // way back to adjust the sliders instead of a crash.
  if (!vocabTest.list.length) {
    document.getElementById("test-body").classList.add("hidden");
    document.getElementById("test-empty").classList.remove("hidden");
    showView("test");
    return;
  }
  document.getElementById("test-empty").classList.add("hidden");
  document.getElementById("test-body").classList.remove("hidden");
  vocabTest.index = 0;
  vocabTest.answeredCount = 0;
  vocabTest.correctCount = 0;
  vocabTest.missed = [];
  vocabTest.inProgress = true;
  vocabTest.startedAt = Date.now();
  vocabTest.timeLimitMs = settings.testMinutes * 60 * 1000;
  document.getElementById("test-form").classList.remove("hidden");
  showView("test");
  startRoundTimer(updateTestTimeDisplay);
  showTestWord();

  // Picks up any progress synced from another device since this device's
  // last reconcile (page load, or last time it regained focus) - fired
  // here, AFTER the round is already showing its first word, specifically
  // so it can never delay or interfere with the synchronous gesture chain
  // above. If it actually pulls something newer, only the not-yet-reached
  // TAIL of this round's list is rebuilt with it (excluding words already
  // presented, so nothing repeats) - the word currently on screen, and
  // everything already answered, is left completely alone.
  if (window.VocabSync) {
    window.VocabSync.reconcileBeforeStarting().then((result) => {
      if (!result || !result.changed || !vocabTest.inProgress) return;
      const presented = new Set(vocabTest.list.slice(0, vocabTest.index + 1).map((w) => w.word.toLowerCase()));
      const freshPool = wordsForLevels(levels);
      const freshList = Logic.selectQuestions({
        pool: freshPool,
        historyStore: progressStore,
        size: pool.length,
        ratio: currentModeRatioFraction(freshPool),
      }).filter((w) => !presented.has(w.word.toLowerCase()));
      vocabTest.list = vocabTest.list.slice(0, vocabTest.index + 1).concat(freshList);
      preloadNextAudio();
    });
  }
});

function showTestWord() {
  const item = vocabTest.list[vocabTest.index];
  updateTestProgressDisplay();
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
  preloadNextAudio();
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

  const { history, priorAvg } = recordResult(item, correct, elapsed, guess);
  vocabTest.answered = true;
  vocabTest.answeredCount += 1;
  input.disabled = true;
  if (correct) vocabTest.correctCount += 1;
  else vocabTest.missed.push(item);

  const note = correct ? speedNote(priorAvg, elapsed) : null;
  const state = Logic.classifyState(history);
  renderAnswerFeedback(document.getElementById("test-feedback"), item, correct, guess, note, state);

  // Re-derives auto mode's ratio from the just-updated word counts and
  // rebuilds the round's remaining tail with it, then preloads whatever
  // word that leaves as "next" - see rebalanceAutoModeTail. A no-op in any
  // other mode.
  rebalanceAutoModeTail();

  const isLast = testTimeUp() || vocabTest.index >= vocabTest.list.length - 1;
  const nextBtn = document.getElementById("test-next-btn");
  nextBtn.textContent = isLast ? "看結果 →" : "下一題 →";
  nextBtn.classList.remove("hidden");
});

document.getElementById("test-next-btn").addEventListener("click", advanceTest);

function advanceTest() {
  if (!testTimeUp() && vocabTest.index < vocabTest.list.length - 1) {
    vocabTest.index += 1;
    showTestWord();
  } else {
    finishTest();
  }
}

function finishTest() {
  vocabTest.inProgress = false;
  stopRoundTimer();
  document.getElementById("test-progress-fill").style.width = "100%";
  document.getElementById("test-form").classList.add("hidden");
  document.getElementById("test-feedback").classList.add("hidden");
  document.getElementById("test-next-btn").classList.add("hidden");

  // vocabTest.list was built generously (the whole available pool - see
  // start-test-btn) since the round is time-boxed, not question-counted;
  // only the prefix actually reached before time ran out was really part
  // of this round, hence the slice rather than the full list.
  const total = vocabTest.answeredCount;
  const presented = vocabTest.list.slice(0, total);
  document.getElementById("test-summary-score").textContent = total
    ? `答對 ${vocabTest.correctCount} / ${total} 題（${Math.round((vocabTest.correctCount / total) * 100)}%）`
    : "這回合時間到之前還沒作答任何一題。";

  const missedDiv = document.getElementById("test-summary-missed");
  missedDiv.innerHTML = "";
  if (vocabTest.missed.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "拼錯的單字（點擊查看中文意思，已加入「答錯待複習」清單）：";
    missedDiv.appendChild(p);
    const holder = document.createElement("div");
    missedDiv.appendChild(holder);
    renderWordChipList(holder, vocabTest.missed);
  } else if (total) {
    missedDiv.innerHTML = `<p class="hint">全部答對，太厲害了！🎉</p>`;
  }

  const allDiv = document.getElementById("test-summary-all");
  allDiv.innerHTML = "";
  if (total) {
    const allP = document.createElement("p");
    allP.className = "hint";
    allP.textContent = "本回合全部單字（點擊查看中文意思）：";
    allDiv.appendChild(allP);
    const allHolder = document.createElement("div");
    allDiv.appendChild(allHolder);
    renderWordChipList(allHolder, presented);
  }

  document.getElementById("test-summary").classList.remove("hidden");
  // "每次完成測驗就同步" - see sync.js's syncNow, same immediate trigger
  // the every-20-answers safety net in recordResult uses, just guaranteed
  // at the natural end of every round regardless of how many questions it
  // actually contained.
  if (window.VocabSync) window.VocabSync.syncNow();
}

document.getElementById("test-again-btn").addEventListener("click", () => {
  document.getElementById("start-test-btn").click();
});
document.getElementById("test-home-btn").addEventListener("click", () => showView("home"));
document.getElementById("test-empty-home-btn").addEventListener("click", () => showView("home"));

// Mid-round exit: ends the round right now and shows the summary for
// whatever was actually answered so far - the same outcome as the clock
// running out, just triggered on purpose instead of waited out. A light
// confirm guards against an accidental tap (e.g. a mis-tap while typing)
// throwing away an otherwise-still-running round; unlike the tab-away
// confirm, "確定" here doesn't need to warn about anything being
// discarded, since finishTest() already keeps everything answered so far.
document.getElementById("test-exit-btn").addEventListener("click", async () => {
  if (!vocabTest.inProgress) return;
  const confirmed = await showConfirmDialog("確定要提早結束這一回合嗎？會直接顯示目前的成績。", {
    confirmText: "結束",
  });
  if (!confirmed) return;
  finishTest();
});

/* ---------- Review List (browsable Learning / Incorrect words) ----------
   Two orthogonal choices, each its own row of tabs: WHICH category
   (答錯待複習 / 學習中 - never both at once, so a word only ever needs
   attention in one place at a time) and HOW to browse it (列表, the
   original searchable/sortable/paginated word-card list, still there for
   anyone who wants to scan or search; or 卡片瀏覽, one big flashcard at a
   time - tap to flip, swipe or ‹ › through the deck, then an optional
   "測驗這些單字" button that starts a REAL quiz round scoped to exactly
   this deck. Answers there record completely normally (see
   startReviewDeckTest) - reviewing a word here is exactly as real as
   reviewing it anywhere else in the app, so a streak built here genuinely
   moves a word toward Memorized. */

const REVIEWLIST_PAGE_SIZE = 20;
let reviewListCategory = "incorrect"; // "incorrect" | "learning"
let reviewListViewMode = "list"; // "list" | "cards"
let reviewListSearch = "";
let reviewListSort = { incorrect: "tries", learning: "slow" };
let reviewListPage = 0;
let reviewListCardIndex = 0;
// The exact ordered item list ({detail, lastSeen}[]) the flashcard view is
// currently showing - snapshotted by renderReviewListCardView so prev/next
// navigation and "測驗這些單字" both work off one stable list rather than
// each recomputing (and potentially disagreeing on order/content).
let reviewListCardDeck = [];

const REVIEWLIST_SORT_OPTIONS = {
  incorrect: [
    { value: "tries", label: "嘗試次數（多到少）" },
    { value: "recent", label: "最近錯誤（新到舊）" },
    { value: "oldest", label: "最近錯誤（舊到新）" },
    { value: "slow", label: "反應時間（慢到快）" },
    { value: "az", label: "字母順序 A→Z" },
  ],
  learning: [
    { value: "slow", label: "反應時間（慢到快）" },
    { value: "tries", label: "嘗試次數（多到少）" },
    { value: "streak", label: "連續正確次數（少到多）" },
    { value: "recent", label: "最近練習（新到舊）" },
    { value: "oldest", label: "最近練習（舊到新）" },
    { value: "az", label: "字母順序 A→Z" },
  ],
};

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
      // Slowest RELATIVE TO THE EXPECTED TIME FOR ITS OWN LENGTH first
      // (see logic.js's relativeResponseTime/computeResponseTimeBaseline),
      // matching the same priority the quiz's own question selection uses
      // (reviewPriorityWeight) - NOT sorted by raw avgCorrectResponseMs,
      // which would just put every long word at the top regardless of how
      // well it's actually known (more characters simply takes longer to
      // type, independent of memorization). Words with no timing data yet
      // sort last.
      arr.sort((a, b) => (b.detail.relativeResponseTime ?? -1) - (a.detail.relativeResponseTime ?? -1));
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

// The current category's items, filtered by search and sorted by the
// current category's own sort choice - the ONE list both the list view and
// the card view build off, so switching between them (or taking a custom
// test) never shows a different word set than what's on screen.
function currentReviewListItems() {
  const pool = reviewListPool();
  const cats = Logic.categorizeWords(pool, progressStore);
  const search = reviewListSearch.trim().toLowerCase();
  // Computed once per call (not per word - see computeWordDetail's own
  // comment) so every word's "反應時間" sort position compares it against
  // the expected time for ITS OWN length, not one flat average dominated
  // by whatever length is most common - see relativeResponseTime.
  const responseTimeBaseline = Logic.computeResponseTimeBaseline(progressStore);
  const words = reviewListCategory === "incorrect" ? cats.incorrect : cats.learning;
  const items = words
    .filter((w) => !search || w.word.toLowerCase().includes(search))
    .map((w) => ({
      detail: Logic.computeWordDetail(w, progressStore, responseTimeBaseline),
      lastSeen: (progressStore[w.word.toLowerCase()] || {}).lastSeen || 0,
    }));
  return sortReviewListItems(items, reviewListSort[reviewListCategory]);
}

function reviewListEmptyText() {
  if (reviewListSearch.trim()) return "沒有符合搜尋的單字。";
  return reviewListCategory === "incorrect"
    ? "目前沒有答錯待複習的單字，太厲害了！"
    : "目前沒有學習中的單字，去做幾回合單字測驗吧！";
}

function populateReviewSortOptions() {
  const select = document.getElementById("reviewlist-sort");
  const current = reviewListSort[reviewListCategory];
  select.innerHTML = REVIEWLIST_SORT_OPTIONS[reviewListCategory]
    .map((o) => `<option value="${o.value}"${o.value === current ? " selected" : ""}>${o.label}</option>`)
    .join("");
}

function renderReviewListListView(items) {
  document.getElementById("reviewlist-list-panel").classList.remove("hidden");
  document.getElementById("reviewlist-card-panel").classList.add("hidden");

  const isIncorrect = reviewListCategory === "incorrect";
  document.getElementById("reviewlist-list-hint").textContent = isIncorrect ? "顯示正確拼法與你打錯的地方。" : "";

  const container = document.getElementById("reviewlist-items");
  const pagerContainer = document.getElementById("reviewlist-pager");
  if (!items.length) {
    container.innerHTML = `<p class="hint">${reviewListEmptyText()}</p>`;
    pagerContainer.innerHTML = "";
    reviewListPage = 0;
    return;
  }
  const totalPages = Math.max(1, Math.ceil(items.length / REVIEWLIST_PAGE_SIZE));
  reviewListPage = Math.min(Math.max(0, reviewListPage), totalPages - 1);
  const start = reviewListPage * REVIEWLIST_PAGE_SIZE;
  const shown = items.slice(start, start + REVIEWLIST_PAGE_SIZE);
  const cardsHtml = shown.map(({ detail }) => buildWordCard(detail, isIncorrect)).join("");
  container.innerHTML = `<div class="word-card-list">${cardsHtml}</div>`;
  pagerContainer.innerHTML = buildPagerHtml("reviewlist", reviewListPage, totalPages, items.length);
}

// The correct word's zh meaning, plus (for 答錯待複習 only, via the same
// diff already used elsewhere - see renderWrongAnswerCell) what was
// actually typed wrong last time - both revealed together the moment a
// flashcard is flipped.
function buildFlashcardRevealHtml(detail) {
  const zhHtml = zhLines(detail.zh).map((l) => escapeHtml(l)).join("<br>");
  const wrongHtml = detail.lastWrongAnswer ? `<div class="word-card-wrong">${renderWrongAnswerCell(detail)}</div>` : "";
  return `<div>${zhHtml}</div>${wrongHtml}`;
}

function renderFlashcard() {
  const items = reviewListCardDeck;
  if (!items.length) return;
  const { detail } = items[reviewListCardIndex];

  document.getElementById("flashcard-progress").textContent = `第 ${reviewListCardIndex + 1} / ${items.length} 張`;
  document.getElementById("flashcard-level").textContent = `Level ${detail.level}`;
  document.getElementById("flashcard-word").textContent = detail.word;
  document.getElementById("flashcard-pos").textContent = detail.pos || "";
  document.getElementById("flashcard-play-btn").dataset.word = detail.word;

  // Meaning shows immediately, no tap needed - this is a study view, not a
  // guess-then-check quiz (that's what the real quiz mode is for). Tapping
  // the card still toggles it away and back, for anyone who wants to cover
  // it and test themselves before checking - see toggleFlashcardReveal.
  const revealEl = document.getElementById("flashcard-reveal");
  revealEl.classList.remove("hidden");
  revealEl.innerHTML = buildFlashcardRevealHtml(detail);
  document.getElementById("flashcard-tap-hint").textContent = "點卡片可暫時隱藏意思";

  document.getElementById("flashcard-prev-btn").disabled = reviewListCardIndex <= 0;
  document.getElementById("flashcard-next-btn").disabled = reviewListCardIndex >= items.length - 1;

  // Same lag-reduction idea as the quiz's own preloadNextAudio.
  const next = items[reviewListCardIndex + 1];
  if (next) loadAudioBuffer(next.detail.word).catch(() => {});

  speak(detail.word);

  // This card has now genuinely been reviewed this session - see
  // startReviewDeckTest/MIN_REVIEW_DECK_TEST_WORDS.
  reviewListViewedWords.add(detail.word.toLowerCase());
  updateFlashcardTestButtonState();
}

function toggleFlashcardReveal() {
  const revealEl = document.getElementById("flashcard-reveal");
  const hintEl = document.getElementById("flashcard-tap-hint");
  const nowHidden = revealEl.classList.toggle("hidden");
  hintEl.textContent = nowHidden ? "點卡片看意思" : "點卡片可暫時隱藏意思";
}

function renderReviewListCardView(items) {
  document.getElementById("reviewlist-list-panel").classList.add("hidden");
  document.getElementById("reviewlist-card-panel").classList.remove("hidden");

  const emptyEl = document.getElementById("reviewlist-card-empty");
  const bodyEl = document.getElementById("reviewlist-card-body");
  if (!items.length) {
    emptyEl.textContent = reviewListEmptyText();
    emptyEl.classList.remove("hidden");
    bodyEl.classList.add("hidden");
    reviewListCardDeck = [];
    updateFlashcardTestButtonState();
    return;
  }
  emptyEl.classList.add("hidden");
  bodyEl.classList.remove("hidden");
  reviewListCardDeck = items;
  reviewListCardIndex = Math.min(Math.max(0, reviewListCardIndex), items.length - 1);
  renderFlashcard();
}

function renderReviewList() {
  populateReviewSortOptions();
  const cats = Logic.categorizeWords(reviewListPool(), progressStore);
  document.getElementById("reviewlist-incorrect-count").textContent = cats.incorrect.length;
  document.getElementById("reviewlist-learning-count").textContent = cats.learning.length;

  const items = currentReviewListItems();
  if (reviewListViewMode === "list") renderReviewListListView(items);
  else renderReviewListCardView(items);
}

// A word only actually counts as "reviewed" once its card has been shown
// this browsing session (see renderFlashcard) - flipping through 2 of 20
// cards and hitting "test" must only test those 2, not all 20, otherwise
// "測驗這些單字" would silently include words the user never actually
// looked at this round. Reset any time the underlying deck changes (see
// the category/search/sort handlers below) so a stale viewed-set from a
// previous deck can never leak into a new one.
let reviewListViewedWords = new Set();

// Below this many reviewed words, a test is answering straight out of
// short-term/working memory (you just read it two seconds ago) rather than
// real recall - clamped to the deck's own size so a genuinely small
// category (e.g. only 3 incorrect words total) still becomes testable once
// all 3 are reviewed, instead of an unreachable fixed floor.
const MIN_REVIEW_DECK_TEST_WORDS = 5;

function reviewDeckTestRequirement() {
  return Math.min(MIN_REVIEW_DECK_TEST_WORDS, reviewListCardDeck.length);
}

function reviewedDeckWords() {
  return reviewListCardDeck.filter((item) => reviewListViewedWords.has(item.detail.word.toLowerCase()));
}

// Keeps the "測驗這些單字" button (and its hint) in sync with how many of
// the current deck's words have actually been reviewed this session.
function updateFlashcardTestButtonState() {
  const btn = document.getElementById("flashcard-test-btn");
  const hintEl = document.getElementById("flashcard-test-hint");
  if (!btn || !hintEl) return;
  const total = reviewListCardDeck.length;
  if (!total) {
    btn.disabled = true;
    hintEl.textContent = "";
    return;
  }
  const required = reviewDeckTestRequirement();
  const reviewedCount = reviewedDeckWords().length;
  const ready = reviewedCount >= required;
  btn.disabled = !ready;
  hintEl.textContent = ready
    ? `已複習 ${reviewedCount} 個單字，可以開始測驗。`
    : `再複習 ${required - reviewedCount} 個單字就能開始測驗（至少 ${required} 個，避免只靠剛看過的短期記憶作答）。`;
}

// Starts a REAL quiz round (reusing the exact same vocabTest engine as the
// home screen's own modes - see the vocabTest object's own comment on
// `customDeck`) scoped to exactly the words actually reviewed in the
// flashcard deck this session (see reviewListViewedWords) - never the
// whole category/search-filtered deck regardless of how much of it was
// actually looked at. Answers record completely normally: this is not a
// separate "practice" mode, it's the same dictation quiz with a hand-picked
// word list instead of a ratio-driven one. Never time-boxed (see
// testTimeUp's own customDeck check) - it ends once every one of these
// words has been gone through, not when a clock runs out.
function startReviewDeckTest() {
  const reviewed = reviewedDeckWords();
  if (reviewed.length < reviewDeckTestRequirement()) return; // the button is disabled for this too - never trust the DOM alone
  const deck = reviewed.map((item) => item.detail);
  getAudioContext();
  const shuffled = Logic.shuffle(deck);
  vocabTest.list = shuffled;
  vocabTest.pool = shuffled;
  vocabTest.customDeck = true;
  document.getElementById("test-summary").classList.add("hidden");
  document.getElementById("test-empty").classList.add("hidden");
  document.getElementById("test-body").classList.remove("hidden");
  vocabTest.index = 0;
  vocabTest.answeredCount = 0;
  vocabTest.correctCount = 0;
  vocabTest.missed = [];
  vocabTest.inProgress = true;
  vocabTest.startedAt = Date.now();
  document.getElementById("test-form").classList.remove("hidden");
  showView("test");
  // No round timer - a customDeck round has no clock to tick (see
  // testTimeUp/updateTestProgressDisplay); stopRoundTimer just clears any
  // interval left running from a previous, genuinely time-boxed round.
  stopRoundTimer();
  showTestWord();
}

document.getElementById("reviewlist-category-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented-btn[data-category]");
  if (!btn || btn.dataset.category === reviewListCategory) return;
  reviewListCategory = btn.dataset.category;
  reviewListPage = 0;
  reviewListCardIndex = 0;
  reviewListViewedWords = new Set(); // a different word set entirely - see startReviewDeckTest
  document.querySelectorAll("#reviewlist-category-tabs .segmented-btn").forEach((b) => b.classList.toggle("active", b === btn));
  renderReviewList();
});

document.getElementById("reviewlist-view-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented-btn[data-mode]");
  if (!btn || btn.dataset.mode === reviewListViewMode) return;
  reviewListViewMode = btn.dataset.mode;
  document.querySelectorAll("#reviewlist-view-tabs .segmented-btn").forEach((b) => b.classList.toggle("active", b === btn));
  renderReviewList();
});

document.getElementById("reviewlist-search").addEventListener("input", (e) => {
  reviewListSearch = e.target.value;
  reviewListPage = 0;
  reviewListCardIndex = 0;
  reviewListViewedWords = new Set(); // a different (filtered) word set - see startReviewDeckTest
  renderReviewList();
});

document.getElementById("reviewlist-sort").addEventListener("change", (e) => {
  reviewListSort[reviewListCategory] = e.target.value;
  reviewListPage = 0;
  reviewListCardIndex = 0;
  // Same word set, just reordered - no reason to make the user re-review
  // words they've already looked at purely because they changed the sort.
  renderReviewList();
});

document.getElementById("flashcard-prev-btn").addEventListener("click", () => {
  if (reviewListCardIndex > 0) {
    reviewListCardIndex -= 1;
    renderFlashcard();
  }
});
document.getElementById("flashcard-next-btn").addEventListener("click", () => {
  if (reviewListCardIndex < reviewListCardDeck.length - 1) {
    reviewListCardIndex += 1;
    renderFlashcard();
  }
});
document.getElementById("flashcard-test-btn").addEventListener("click", startReviewDeckTest);

// Drag-to-swipe + tap-to-flip on the flashcard itself, via Pointer Events
// (covers touch, mouse, and pen in one set of listeners - no separate
// touch/mouse handling needed). A genuine swipe (past
// FLASHCARD_SWIPE_THRESHOLD_PX) advances/retreats through the deck with a
// fly-away animation; anything smaller that still moved snaps back; a tap
// (moved less than FLASHCARD_TAP_TOLERANCE_PX) flips the card instead.
const FLASHCARD_SWIPE_THRESHOLD_PX = 70;
const FLASHCARD_TAP_TOLERANCE_PX = 8;
const FLASHCARD_SWIPE_OUT_MS = 180;

(function setupFlashcardSwipe() {
  const el = document.getElementById("flashcard");
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let moved = false;

  function resetTransform() {
    el.style.transform = "";
    el.style.opacity = "";
  }

  // delta: +1 = next card (swiped left), -1 = previous card (swiped right).
  function goTo(delta) {
    const lastIndex = reviewListCardDeck.length - 1;
    const target = reviewListCardIndex + delta;
    if (target < 0 || target > lastIndex) {
      resetTransform();
      return;
    }
    el.style.transform = `translateX(${delta > 0 ? -520 : 520}px) rotate(${delta > 0 ? -18 : 18}deg)`;
    el.style.opacity = "0";
    setTimeout(() => {
      reviewListCardIndex = target;
      el.classList.add("dragging"); // suppress the transition for this reset jump
      resetTransform();
      renderFlashcard();
      requestAnimationFrame(() => el.classList.remove("dragging"));
    }, FLASHCARD_SWIPE_OUT_MS);
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".flashcard-play-btn")) return; // let its own click handler run
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > FLASHCARD_TAP_TOLERANCE_PX || Math.abs(dy) > FLASHCARD_TAP_TOLERANCE_PX) moved = true;
    el.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
  });
  el.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    const dx = e.clientX - startX;
    if (!moved) {
      resetTransform();
      toggleFlashcardReveal();
    } else if (dx <= -FLASHCARD_SWIPE_THRESHOLD_PX) {
      goTo(1);
    } else if (dx >= FLASHCARD_SWIPE_THRESHOLD_PX) {
      goTo(-1);
    } else {
      resetTransform();
    }
  });
  el.addEventListener("pointercancel", () => {
    dragging = false;
    el.classList.remove("dragging");
    resetTransform();
  });
})();

// Delegated so it keeps working across re-renders: play a word's
// pronunciation (list-view word cards AND the flashcard's own play button,
// which shares the same .card-play-btn class), toggle a list-view card's
// Chinese meaning open/closed, or page the list.
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
    reviewListPage = Math.max(0, reviewListPage + Number(pagerBtn.dataset.dir));
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

  let trendText = "還沒有足夠的紀錄可以分析。";
  if (summary.recentAccuracy != null) {
    if (summary.responseTimeTrend > 0.05) trendText = "最近反應變快了，越來越熟練！";
    else if (summary.responseTimeTrend < -0.05) trendText = "最近反應變慢了，可能需要多複習。";
    else trendText = "最近反應時間大致穩定。";
  }
  document.getElementById("progress-trend-hint").textContent = trendText;

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
// Correct word's spelling as HTML, with letters the user did NOT type (in
// order) highlighted - shared by the in-round answer feedback
// (renderAnswerFeedback) and the Progress/複習 word cards
// (renderWrongAnswerCell) so "wierd" vs "weird" visually shows the swapped
// letters in both places, not just one.
function buildDiffHtml(typed, correctWord) {
  const ops = Logic.diffChars(typed, correctWord);
  return ops
    .map((o) => (o.match ? escapeHtml(o.char) : `<span class="diff-miss">${escapeHtml(o.char)}</span>`))
    .join("");
}

function renderWrongAnswerCell(detail) {
  if (!detail.lastWrongAnswer) return "—";
  const correctHtml = buildDiffHtml(detail.lastWrongAnswer, detail.word);
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
    <p class="hint">連續答對 2 次算「已熟記」，答錯一次會重新歸零。滑鼠移到「最近錯誤」可看更多紀錄。</p>
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
  reader.onload = async () => {
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
    const confirmed = await showConfirmDialog(
      `即將匯入備份檔（${wordCount} 個單字的紀錄${parsed.exportedAt ? `，匯出於 ${parsed.exportedAt.slice(0, 10)}` : ""}）。\n\n` +
      "這會「取代」目前這台裝置瀏覽器裡的全部學習紀錄，無法復原，確定要繼續嗎？",
      { confirmText: "匯入", danger: true }
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

document.getElementById("reset-progress-btn").addEventListener("click", async () => {
  const confirmed = await showConfirmDialog("確定要清除全部學習紀錄嗎？此動作無法復原。", {
    confirmText: "清除",
    danger: true,
  });
  if (!confirmed) return;
  progressStore = {};
  saveProgress();
  renderProgress();
  // Clearing also unlinks sync (if configured) - see sync.js's
  // unlinkAfterReset for why: staying paired would just have the very
  // next automatic sync tick pull the pre-reset data back down again
  // (this device's now-zero progress correctly looks "behind" the
  // server), silently undoing the reset. Unlinking is unambiguous: this
  // device simply isn't part of any sync anymore until rejoined, and
  // the server/other devices are untouched either way.
  if (window.VocabSync) window.VocabSync.unlinkAfterReset();
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
  applySettingsToUI(); // also refreshes the auto-mode ratio hint via applyModeToUI
  // Pre-renders 複習 right away instead of waiting for its tab to be
  // clicked the first time - showView() only toggles CSS visibility (the
  // underlying DOM is never removed), so there is nothing wrong with
  // populating it before it is ever shown. Without this, the tab's FIRST
  // ever click could show whatever was already in the DOM at that instant
  // (nothing, on a fresh load) while the real render was still catching up
  // to state set up earlier in init() - by rendering it here, the content
  // is already correct and waiting the moment the tab becomes visible, on
  // the very first click, not the next one.
  renderReviewList();

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
