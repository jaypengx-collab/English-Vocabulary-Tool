"use strict";

/* ---------- Constants ---------- */

const ONE_DAY = 24 * 60 * 60 * 1000;
// Leitner-style box -> interval before the word is due again.
const BOX_INTERVALS_MS = [
  0,                 // box 0: new / just failed -> due immediately
  10 * 60 * 1000,    // box 1: 10 minutes
  ONE_DAY,           // box 2: 1 day
  3 * ONE_DAY,       // box 3: 3 days
  7 * ONE_DAY,       // box 4: 7 days
  16 * ONE_DAY,      // box 5: 16 days (considered "mastered")
  35 * ONE_DAY,      // box 6: 35 days
];
const MAX_BOX = BOX_INTERVALS_MS.length - 1;
const MASTERED_BOX = 5;

// Response-time model: predicts how long a correct answer "should" take
// (listening + typing), so an unusually slow-but-correct answer can be
// treated as shaky knowledge rather than a fully mastered word.
const DEFAULT_MS_PER_CHAR = 350;
const FIXED_OVERHEAD_MS = 900;
const SLOW_RATIO_THRESHOLD = 1.7;

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

let progressStore = loadJSON(PROGRESS_KEY, {});
let settings = Object.assign(
  { levels: [4, 5, 6], voiceURI: "", rate: 0.9, sessionSize: 20, msPerChar: DEFAULT_MS_PER_CHAR },
  loadJSON(SETTINGS_KEY, {})
);

function saveProgress() {
  saveJSON(PROGRESS_KEY, progressStore);
}

function saveSettings() {
  saveJSON(SETTINGS_KEY, settings);
}

function getProgress(word) {
  const key = word.toLowerCase();
  if (!progressStore[key]) {
    progressStore[key] = { box: 0, due: 0, correct: 0, wrong: 0, lastSeen: 0 };
  }
  return progressStore[key];
}

function getDue(word) {
  const p = progressStore[word.toLowerCase()];
  return p ? p.due : 0;
}

// How long a correct answer "should" take to type, given the word's
// length and how fast this user has been typing correct answers so far.
function expectedResponseTimeMs(word) {
  return FIXED_OVERHEAD_MS + settings.msPerChar * word.length;
}

// Nudges the learned typing speed baseline toward this sample. Only called
// for correct answers, and outliers (e.g. the user walked away) are capped
// so one distracted answer can't wreck the baseline.
function updateTypingSpeed(word, elapsedMs) {
  const capped = Math.min(elapsedMs, expectedResponseTimeMs(word) * 4);
  const perChar = capped / Math.max(3, word.length);
  settings.msPerChar = settings.msPerChar * 0.85 + perChar * 0.15;
  saveSettings();
}

function recordDictationResult(word, correct, slow) {
  const p = getProgress(word);
  if (correct) {
    p.correct += 1;
    if (slow) {
      // Correct, but took much longer than expected: recall was shaky, so
      // don't advance the box - keep the same (shorter) review interval
      // instead of pushing this word further away.
    } else {
      p.box = Math.min(MAX_BOX, p.box + 1);
    }
  } else {
    p.box = 0;
    p.wrong += 1;
  }
  p.due = Date.now() + BOX_INTERVALS_MS[p.box];
  p.lastSeen = Date.now();
  saveProgress();
}

function recordReviewGrade(word, grade) {
  const p = getProgress(word);
  if (grade === "again") {
    p.box = 0;
    p.wrong += 1;
  } else if (grade === "hard") {
    p.wrong += 1;
  } else if (grade === "good") {
    p.box = Math.min(MAX_BOX, p.box + 1);
    p.correct += 1;
  } else if (grade === "easy") {
    p.box = Math.min(MAX_BOX, p.box + 2);
    p.correct += 1;
  }
  p.due = Date.now() + BOX_INTERVALS_MS[p.box];
  p.lastSeen = Date.now();
  saveProgress();
}

/* ---------- Vocabulary data ---------- */

let VOCAB = [];
let VOCAB_BY_LEVEL = { 4: [], 5: [], 6: [] };

async function loadVocab() {
  const res = await fetch("data/vocab.json?v=3");
  VOCAB = await res.json();
  VOCAB_BY_LEVEL = { 4: [], 5: [], 6: [] };
  for (const w of VOCAB) {
    VOCAB_BY_LEVEL[w.level].push(w);
  }
  document.getElementById("footer-total").textContent = VOCAB.length;
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

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildSession(pool, size) {
  const now = Date.now();
  // Shuffle before sorting: words with the same due time (e.g. everything
  // is "due" the first time you ever open the app) would otherwise keep
  // the list's original order - alphabetical, one level at a time - since
  // Array.prototype.sort is stable. Shuffling first makes ties (and so the
  // level mix and the pick order) random instead.
  const withDue = shuffle(pool).map((w) => ({ w, due: getDue(w.word) }));
  withDue.sort((a, b) => a.due - b.due);
  const due = withDue.filter((x) => x.due <= now).map((x) => x.w);
  const notDue = withDue.filter((x) => x.due > now).map((x) => x.w);

  let list;
  if (!size) {
    list = due.concat(notDue);
  } else {
    list = due.slice(0, size);
    if (list.length < size) {
      list = list.concat(notDue.slice(0, size - list.length));
    }
  }
  return shuffle(list);
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

function fillZhInto(el, zh) {
  el.innerHTML = "";
  zhLines(zh).forEach((line, i) => {
    if (i > 0) el.appendChild(document.createElement("br"));
    el.appendChild(document.createTextNode(line));
  });
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
  if (name === "stats") renderStats();
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

/* ---------- Dictation mode ---------- */

const dict = { list: [], index: 0, correctCount: 0, missed: [], answered: false, wordShownAt: 0 };

document.getElementById("start-dictation-btn").addEventListener("click", () => {
  const levels = selectedLevels();
  if (!levels.length) return;
  const pool = wordsForLevels(levels);
  dict.list = buildSession(pool, settings.sessionSize);
  dict.index = 0;
  dict.correctCount = 0;
  dict.missed = [];
  document.getElementById("dict-summary").classList.add("hidden");
  document.getElementById("dict-form").classList.remove("hidden");
  showView("dictation");
  showDictWord();
});

function showDictWord() {
  const total = dict.list.length;
  const item = dict.list[dict.index];
  document.getElementById("dict-progress-text").textContent = `${dict.index + 1} / ${total}`;
  document.getElementById("dict-progress-fill").style.width = `${(dict.index / total) * 100}%`;
  document.getElementById("dict-level-badge").textContent = `Level ${item.level}`;

  dict.answered = false;
  const input = document.getElementById("dict-input");
  input.value = "";
  input.disabled = false;
  document.getElementById("dict-submit-btn").disabled = false;
  document.getElementById("dict-feedback").classList.add("hidden");
  document.getElementById("dict-next-btn").classList.add("hidden");
  input.focus();

  dict.wordShownAt = Date.now();
  speak(item.word);
}

document.getElementById("dict-play-btn").addEventListener("click", () => {
  speak(dict.list[dict.index].word);
});
document.getElementById("dict-replay-btn").addEventListener("click", () => {
  speak(dict.list[dict.index].word);
});

document.getElementById("dict-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (dict.answered) {
    advanceDictation();
    return;
  }
  const item = dict.list[dict.index];
  const input = document.getElementById("dict-input");
  const guess = input.value.trim().toLowerCase();
  const correct = guess === item.word.toLowerCase();

  const elapsed = Date.now() - dict.wordShownAt;
  const slow = correct && elapsed > expectedResponseTimeMs(item.word) * SLOW_RATIO_THRESHOLD;
  if (correct && !slow) updateTypingSpeed(item.word, elapsed);

  recordDictationResult(item.word, correct, slow);
  dict.answered = true;
  input.disabled = true;

  const feedback = document.getElementById("dict-feedback");
  feedback.classList.remove("hidden", "correct", "wrong");
  feedback.innerHTML = "";

  const title = document.createElement("div");
  const answerWord = document.createElement("div");
  answerWord.className = "answer-word";
  if (correct) {
    dict.correctCount += 1;
    feedback.classList.add("correct");
    title.textContent = "✅ 正確！";
    answerWord.textContent = `${item.word} `;
  } else {
    dict.missed.push(item);
    feedback.classList.add("wrong");
    title.textContent = `❌ 再加油　你的答案：${guess || "(空白)"}`;
    answerWord.textContent = `正確答案：${item.word} `;
  }
  const posSpan = document.createElement("span");
  posSpan.className = "muted";
  posSpan.textContent = item.pos;
  answerWord.appendChild(posSpan);

  feedback.appendChild(title);
  feedback.appendChild(answerWord);
  feedback.appendChild(buildZhBlock(item.zh));

  if (slow) {
    const note = document.createElement("div");
    note.className = "slow-note";
    note.textContent = "⏱️ 這題你想了比較久才答對，系統判斷你還不夠熟，會讓它提早再出現一次。";
    feedback.appendChild(note);
  }

  const isLast = dict.index === dict.list.length - 1;
  const nextBtn = document.getElementById("dict-next-btn");
  nextBtn.textContent = isLast ? "看結果 →" : "下一題 →";
  nextBtn.classList.remove("hidden");
});

document.getElementById("dict-next-btn").addEventListener("click", advanceDictation);

function advanceDictation() {
  if (dict.index < dict.list.length - 1) {
    dict.index += 1;
    showDictWord();
  } else {
    finishDictation();
  }
}

function finishDictation() {
  document.getElementById("dict-progress-fill").style.width = "100%";
  document.getElementById("dict-form").classList.add("hidden");
  document.getElementById("dict-feedback").classList.add("hidden");
  document.getElementById("dict-next-btn").classList.add("hidden");

  const total = dict.list.length;
  document.getElementById("dict-summary-score").textContent =
    `答對 ${dict.correctCount} / ${total} 題（${Math.round((dict.correctCount / total) * 100)}%）`;

  const missedDiv = document.getElementById("dict-summary-missed");
  missedDiv.innerHTML = "";
  if (dict.missed.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "拼錯的單字（點擊查看中文意思）：";
    missedDiv.appendChild(p);
    const holder = document.createElement("div");
    missedDiv.appendChild(holder);
    renderWordChipList(holder, dict.missed);
  } else {
    missedDiv.innerHTML = `<p class="hint">全部答對，太厲害了！🎉</p>`;
  }

  const allDiv = document.getElementById("dict-summary-all");
  allDiv.innerHTML = "";
  const allP = document.createElement("p");
  allP.className = "hint";
  allP.textContent = "本回合全部單字（點擊查看中文意思）：";
  allDiv.appendChild(allP);
  const allHolder = document.createElement("div");
  allDiv.appendChild(allHolder);
  renderWordChipList(allHolder, dict.list);

  document.getElementById("dict-summary").classList.remove("hidden");
}

document.getElementById("dict-again-btn").addEventListener("click", () => {
  document.getElementById("start-dictation-btn").click();
});
document.getElementById("dict-home-btn").addEventListener("click", () => showView("home"));

/* ---------- Review mode (flashcards / SRS) ---------- */

const rev = { list: [], index: 0, grades: { again: 0, hard: 0, good: 0, easy: 0 } };

document.getElementById("start-review-btn").addEventListener("click", () => {
  const levels = selectedLevels();
  if (!levels.length) return;
  const pool = wordsForLevels(levels);
  rev.list = buildSession(pool, settings.sessionSize);
  rev.index = 0;
  rev.grades = { again: 0, hard: 0, good: 0, easy: 0 };
  document.getElementById("rev-summary").classList.add("hidden");
  document.getElementById("rev-flashcard").classList.remove("hidden");
  document.getElementById("rev-reveal-btn").classList.remove("hidden");
  showView("review");
  showRevCard();
});

function showRevCard() {
  const total = rev.list.length;
  const item = rev.list[rev.index];
  document.getElementById("rev-progress-text").textContent = `${rev.index + 1} / ${total}`;
  document.getElementById("rev-progress-fill").style.width = `${(rev.index / total) * 100}%`;
  document.getElementById("rev-level-badge").textContent = `Level ${item.level}`;

  document.getElementById("rev-word").textContent = item.word;
  document.getElementById("rev-pos").textContent = item.pos;
  fillZhInto(document.getElementById("rev-zh"), item.zh);
  document.getElementById("rev-word").classList.add("hidden");
  document.getElementById("rev-pos").classList.add("hidden");
  document.getElementById("rev-zh").classList.add("hidden");
  document.getElementById("rev-hint").classList.remove("hidden");
  document.getElementById("rev-reveal-btn").classList.remove("hidden");
  document.getElementById("rev-grade-row").classList.add("hidden");

  speak(item.word);
}

document.getElementById("rev-play-btn").addEventListener("click", () => {
  speak(rev.list[rev.index].word);
});

document.getElementById("rev-reveal-btn").addEventListener("click", () => {
  document.getElementById("rev-word").classList.remove("hidden");
  document.getElementById("rev-pos").classList.remove("hidden");
  document.getElementById("rev-zh").classList.remove("hidden");
  document.getElementById("rev-hint").classList.add("hidden");
  document.getElementById("rev-reveal-btn").classList.add("hidden");
  document.getElementById("rev-grade-row").classList.remove("hidden");
});

document.getElementById("rev-grade-row").addEventListener("click", (e) => {
  const btn = e.target.closest(".grade");
  if (!btn) return;
  const grade = btn.dataset.grade;
  const item = rev.list[rev.index];
  recordReviewGrade(item.word, grade);
  rev.grades[grade] += 1;

  if (rev.index < rev.list.length - 1) {
    rev.index += 1;
    showRevCard();
  } else {
    finishReview();
  }
});

function finishReview() {
  document.getElementById("rev-progress-fill").style.width = "100%";
  document.getElementById("rev-flashcard").classList.add("hidden");
  document.getElementById("rev-reveal-btn").classList.add("hidden");
  document.getElementById("rev-grade-row").classList.add("hidden");

  const g = rev.grades;
  document.getElementById("rev-summary-score").textContent =
    `很熟悉 ${g.easy}　記得 ${g.good}　有點難 ${g.hard}　忘記了 ${g.again}`;

  const wordsDiv = document.getElementById("rev-summary-words");
  wordsDiv.innerHTML = "";
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = "本回合單字（點擊查看中文意思）：";
  wordsDiv.appendChild(p);
  const holder = document.createElement("div");
  wordsDiv.appendChild(holder);
  renderWordChipList(holder, rev.list);

  document.getElementById("rev-summary").classList.remove("hidden");
}

document.getElementById("rev-again-btn").addEventListener("click", () => {
  document.getElementById("start-review-btn").click();
});
document.getElementById("rev-home-btn").addEventListener("click", () => showView("home"));

/* ---------- Stats view ---------- */

function classifyWord(word) {
  const p = progressStore[word.toLowerCase()];
  if (!p || p.lastSeen === 0) return "new";
  return p.box >= MASTERED_BOX ? "mastered" : "learning";
}

function renderStats() {
  const now = Date.now();
  let mastered = 0, learning = 0, brandNew = 0, due = 0;

  for (const w of VOCAB) {
    const cls = classifyWord(w.word);
    if (cls === "mastered") mastered += 1;
    else if (cls === "learning") learning += 1;
    else brandNew += 1;
    if (getDue(w.word) <= now && progressStore[w.word.toLowerCase()]) due += 1;
  }

  document.getElementById("stats-grid").innerHTML = `
    <div class="stat-box"><span class="num">${VOCAB.length}</span><span class="label">總單字數</span></div>
    <div class="stat-box"><span class="num">${mastered}</span><span class="label">已熟記</span></div>
    <div class="stat-box"><span class="num">${learning}</span><span class="label">學習中</span></div>
    <div class="stat-box"><span class="num">${brandNew}</span><span class="label">尚未學習</span></div>
    <div class="stat-box"><span class="num">${due}</span><span class="label">待複習</span></div>
  `;

  document.getElementById("stats-speed-hint").textContent =
    `聽寫反應速度基準：每個字元約 ${Math.round(settings.msPerChar)} 毫秒（會隨你的作答自動調整）。` +
    `聽寫時若某題答對但想了明顯比這個基準久，即使答對，該字也會提早再次出現，而不是直接視為已熟記。`;

  const levelsHTML = [4, 5, 6]
    .map((lvl) => {
      const words = VOCAB_BY_LEVEL[lvl];
      let m = 0, l = 0, n = 0;
      for (const w of words) {
        const cls = classifyWord(w.word);
        if (cls === "mastered") m += 1;
        else if (cls === "learning") l += 1;
        else n += 1;
      }
      const total = words.length || 1;
      return `
        <div class="level-stat-row">
          <div class="level-stat-head"><span>Level ${lvl}</span><span>已熟記 ${m} / ${words.length}</span></div>
          <div class="level-stat-bar">
            <div class="seg seg-mastered" style="width:${(m / total) * 100}%"></div>
            <div class="seg seg-learning" style="width:${(l / total) * 100}%"></div>
            <div class="seg seg-new" style="width:${(n / total) * 100}%"></div>
          </div>
        </div>`;
    })
    .join("");
  document.getElementById("stats-levels").innerHTML = levelsHTML;
}

document.getElementById("reset-progress-btn").addEventListener("click", () => {
  if (confirm("確定要清除全部學習紀錄嗎？此動作無法復原。")) {
    progressStore = {};
    saveProgress();
    renderStats();
  }
});

/* ---------- Init ---------- */

async function init() {
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
