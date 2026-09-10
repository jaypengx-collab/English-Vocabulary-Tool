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
  { levels: [4, 5, 6], voiceURI: "", rate: 0.9, sessionSize: 80 },
  loadJSON(SETTINGS_KEY, {})
);

function saveProgress() {
  saveJSON(PROGRESS_KEY, progressStore);
}

function saveSettings() {
  saveJSON(SETTINGS_KEY, settings);
}

// Fetches (creating if needed) the history entry for a vocab item and
// records one answer into it. Used by BOTH the Vocabulary Test and the
// Review Test, so the two modes share one memorization system rather than
// drifting apart, per the app's design.
function recordResult(item, correct, responseMs) {
  const key = item.word.toLowerCase();
  if (!progressStore[key]) {
    progressStore[key] = Logic.createEmptyWordHistory(item.word, item.level, item.word.length);
  }
  const history = progressStore[key];
  const priorAvg = history.avgCorrectResponseMs;
  Logic.recordAttempt(history, {
    correct: correct,
    responseMs: responseMs,
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

async function loadVocab() {
  const res = await fetch("data/vocab.json?v=__BUILD_VERSION__");
  VOCAB = await res.json();
  VOCAB_BY_LEVEL = { 4: [], 5: [], 6: [] };
  const vocabIndex = {};
  for (const w of VOCAB) {
    VOCAB_BY_LEVEL[w.level].push(w);
    vocabIndex[w.word.toLowerCase()] = { word: w.word, level: w.level };
  }
  document.getElementById("footer-total").textContent = VOCAB.length;

  // Backward-compatible migration: upgrades legacy Leitner-box entries (and
  // fills in any newly-added fields on already-current entries) without
  // resetting existing progress. Safe to run on every load - it's a no-op
  // merge once everything is already in the current shape.
  progressStore = Logic.migrateProgressStore(progressStore, vocabIndex);
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

let voices = [];

function refreshVoices() {
  voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  const select = document.getElementById("voice-select");
  const prev = settings.voiceURI;
  select.innerHTML = "";

  const englishVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
  const list = englishVoices.length ? englishVoices : voices;

  for (const v of list) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    select.appendChild(opt);
  }

  if (prev && list.some((v) => v.voiceURI === prev)) {
    select.value = prev;
  } else if (list.length) {
    settings.voiceURI = list[0].voiceURI;
    select.value = list[0].voiceURI;
    saveSettings();
  }
}

function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const voice = voices.find((v) => v.voiceURI === settings.voiceURI);
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang;
  } else {
    utter.lang = "en-US";
  }
  utter.rate = settings.rate;
  window.speechSynthesis.speak(utter);
}

/* ---------- View navigation ---------- */

function showView(name) {
  document.querySelectorAll(".view").forEach((el) => el.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  if (name === "progress") renderProgress();
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

document.getElementById("rate-select").addEventListener("input", (e) => {
  settings.rate = Number(e.target.value);
  document.getElementById("rate-value").textContent = `${settings.rate.toFixed(1)}x`;
  saveSettings();
});

document.getElementById("voice-select").addEventListener("change", (e) => {
  settings.voiceURI = e.target.value;
  saveSettings();
});

document.getElementById("test-voice-btn").addEventListener("click", () => {
  speak("vocabulary");
});

document.getElementById("session-size").addEventListener("change", (e) => {
  settings.sessionSize = Number(e.target.value);
  saveSettings();
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

const vocabTest = { list: [], index: 0, correctCount: 0, missed: [], answered: false, wordShownAt: 0 };

document.getElementById("start-test-btn").addEventListener("click", () => {
  const levels = selectedLevels();
  if (!levels.length) return;
  const pool = wordsForLevels(levels);
  const size = settings.sessionSize && settings.sessionSize > 0 ? settings.sessionSize : pool.length;
  vocabTest.list = Logic.selectTestQuestions({ pool: pool, historyStore: progressStore, size: size });
  vocabTest.index = 0;
  vocabTest.correctCount = 0;
  vocabTest.missed = [];
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

  const { priorAvg } = recordResult(item, correct, elapsed);
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

const reviewTest = { list: [], index: 0, records: [], answered: false, wordShownAt: 0 };

document.getElementById("start-review-btn").addEventListener("click", () => {
  const levels = selectedLevels();
  if (!levels.length) return;
  const pool = wordsForLevels(levels);
  reviewTest.list = Logic.buildReviewTestList({ pool: pool, historyStore: progressStore });
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

  const { priorAvg } = recordResult(item, correct, elapsed);
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
  p.textContent = "本回合複習的單字（點擊查看中文意思）：";
  wordsDiv.appendChild(p);
  const holder = document.createElement("div");
  wordsDiv.appendChild(holder);
  renderWordChipList(holder, reviewTest.list);

  document.getElementById("rev-outcome-prompt").classList.remove("hidden");
  document.getElementById("rev-outcome-note").classList.add("hidden");
  document.getElementById("rev-keep-btn").disabled = false;
  document.getElementById("rev-remove-btn").disabled = false;

  document.getElementById("rev-summary").classList.remove("hidden");
}

function settleReviewOutcome(mode, noteText) {
  Logic.applyReviewOutcome(progressStore, reviewTest.records, mode);
  saveProgress();
  document.getElementById("rev-outcome-prompt").classList.add("hidden");
  const note = document.getElementById("rev-outcome-note");
  note.textContent = noteText;
  note.classList.remove("hidden");
  document.getElementById("rev-keep-btn").disabled = true;
  document.getElementById("rev-remove-btn").disabled = true;
}

document.getElementById("rev-keep-btn").addEventListener("click", () => {
  settleReviewOutcome("keepAll", "已保留全部單字在答錯清單中。");
});
document.getElementById("rev-remove-btn").addEventListener("click", () => {
  const removedCount = reviewTest.records.filter((r) => r.correct).length;
  settleReviewOutcome("removeCorrect", `已將本次答對的 ${removedCount} 個單字從答錯清單移除。`);
});

document.getElementById("rev-again-btn").addEventListener("click", () => {
  document.getElementById("start-review-btn").click();
});
document.getElementById("rev-home-btn").addEventListener("click", () => showView("home"));

/* ---------- Progress view ---------- */

const STATE_LABELS = { new: "尚未測驗", learning: "學習中", review: "待複習", memorized: "已熟記" };

let progressFilter = "attempted";
let progressSearch = "";
const MAX_WORD_ROWS = 300;

document.getElementById("progress-filter").addEventListener("change", (e) => {
  progressFilter = e.target.value;
  renderProgress();
});
document.getElementById("progress-search").addEventListener("input", (e) => {
  progressSearch = e.target.value;
  renderProgress();
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
    <div class="stat-box"><span class="num">${summary.counts.review}</span><span class="label">待複習</span></div>
    <div class="stat-box"><span class="num">${VOCAB.filter((w) => { const h = progressStore[w.word.toLowerCase()]; return h && h.inWrongList; }).length}</span><span class="label">答錯清單</span></div>
    <div class="stat-box"><span class="num">${formatPercent(summary.overallAccuracy)}</span><span class="label">整體正確率</span></div>
    <div class="stat-box"><span class="num">${formatPercent(summary.memorizationRate)}</span><span class="label">熟記率</span></div>
    <div class="stat-box"><span class="num">${formatPercent(summary.recentAccuracy)}</span><span class="label">近期正確率</span></div>
  `;

  let trendText = "尚無足夠的作答紀錄可分析反應時間趨勢。";
  if (summary.recentAccuracy != null) {
    if (summary.responseTimeTrend > 0.05) trendText = "近期反應時間有變快的趨勢，代表越來越熟練。";
    else if (summary.responseTimeTrend < -0.05) trendText = "近期反應時間有變慢的趨勢，可能需要多複習。";
    else trendText = "近期反應時間大致穩定。";
  }
  document.getElementById("progress-trend-hint").textContent = trendText;

  const levelsHTML = [4, 5, 6]
    .map((lvl) => {
      const s = summary.byLevel[lvl] || { total: 0, new: 0, learning: 0, review: 0, memorized: 0 };
      const total = s.total || 1;
      return `
        <div class="level-stat-row">
          <div class="level-stat-head"><span>Level ${lvl}</span><span>已熟記 ${s.memorized} / ${s.total}</span></div>
          <div class="level-stat-bar">
            <div class="seg seg-memorized" style="width:${(s.memorized / total) * 100}%"></div>
            <div class="seg seg-review" style="width:${(s.review / total) * 100}%"></div>
            <div class="seg seg-learning" style="width:${(s.learning / total) * 100}%"></div>
            <div class="seg seg-new" style="width:${(s.new / total) * 100}%"></div>
          </div>
        </div>`;
    })
    .join("");
  document.getElementById("progress-levels").innerHTML = levelsHTML;

  renderWordTable();
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
  if (!details.length) {
    container.innerHTML = `<p class="hint">沒有符合條件的單字。</p>`;
    return;
  }

  const shown = details.slice(0, MAX_WORD_ROWS);
  const rows = shown
    .map(({ detail }) => `
      <tr>
        <td class="word-cell">${detail.word}${detail.inWrongList ? ' <span class="wrong-flag" title="在答錯清單中">⚠️</span>' : ""}</td>
        <td>${detail.level}</td>
        <td>${detail.correct} / ${detail.incorrect}</td>
        <td>${formatMs(detail.avgCorrectResponseMs)}</td>
        <td>${formatPercent(detail.score)}</td>
        <td><span class="state-badge ${detail.state}">${STATE_LABELS[detail.state]}</span></td>
      </tr>`)
    .join("");

  const truncatedNote = details.length > MAX_WORD_ROWS
    ? `<p class="hint">僅顯示前 ${MAX_WORD_ROWS} 筆（共 ${details.length} 筆符合條件），請用搜尋縮小範圍。</p>`
    : "";

  container.innerHTML = `
    <div class="word-table-wrap">
      <table class="word-table">
        <thead><tr><th>單字</th><th>等級</th><th>對／錯</th><th>平均反應時間</th><th>記憶分數</th><th>狀態</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${truncatedNote}
  `;
}

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

  document.getElementById("rate-select").value = settings.rate;
  document.getElementById("rate-value").textContent = `${settings.rate.toFixed(1)}x`;
  document.getElementById("session-size").value = String(settings.sessionSize);

  if (window.speechSynthesis) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }
}

init();
