"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../logic.js");

/* ---------- helpers ---------- */

// Deterministic PRNG for reproducible shuffles in tests.
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function makeWord(word, level) {
  return { id: word, word: word, pos: "n.", level: level, zh: "測試" };
}

function makePool(count, level, prefix) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(makeWord(`${prefix || "w"}${i}`, level));
  return out;
}

// Plays out N attempts against a fresh history for a word.
function play(history, results) {
  let t = 1000;
  for (const r of results) {
    t += 1000;
    L.recordAttempt(history, {
      correct: r.correct,
      responseMs: r.responseMs,
      answer: r.answer,
      timestamp: t,
      level: 4,
      length: history.length,
    });
  }
  return history;
}

/* ================= Recording: correctness, response time, length, attempts, wrong answers ================= */

test("recordAttempt tracks correct/incorrect, response time, length, attempt number and the typed wrong answer", () => {
  const h = L.createEmptyWordHistory("extraordinary", 6, 13);
  L.recordAttempt(h, { correct: true, responseMs: 2200, timestamp: 5000, level: 6, length: 13 });
  assert.equal(h.attempts, 1);
  assert.equal(h.correct, 1);
  assert.equal(h.incorrect, 0);
  assert.equal(h.length, 13);
  assert.equal(h.level, 6);
  assert.equal(h.recentResponseMs, 2200);
  assert.equal(h.recentAttempts[0].attemptNumber, 1);
  assert.equal(h.recentAttempts[0].responseMs, 2200);
  assert.equal(h.lastResult, "correct");
  assert.equal(h.lastWrongAnswer, null);

  L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 6000, level: 6, length: 13, answer: "extrordinary" });
  assert.equal(h.attempts, 2);
  assert.equal(h.incorrect, 1);
  assert.equal(h.recentAttempts[1].attemptNumber, 2);
  assert.equal(h.lastResult, "incorrect");
  assert.equal(h.lastWrongAnswer, "extrordinary", "the exact mistyped answer should be recorded");
  assert.equal(h.recentAttempts[1].answer, "extrordinary");
});

test("a correct attempt does not store an 'answer' in the ring buffer (it's trivially the word itself)", () => {
  const h = L.createEmptyWordHistory("cat", 4, 3);
  L.recordAttempt(h, { correct: true, responseMs: 500, timestamp: 1000, answer: "cat" });
  assert.equal(h.recentAttempts[0].answer, undefined);
});

test("recordAttempt handles multiple attempts and caps the detailed ring buffer without losing aggregate counts", () => {
  const h = L.createEmptyWordHistory("run", 4, 3);
  for (let i = 0; i < 30; i++) {
    L.recordAttempt(h, { correct: i % 3 !== 0, responseMs: 800 + i, timestamp: 1000 + i, level: 4, length: 3, answer: i % 3 !== 0 ? undefined : "rnu" });
  }
  assert.equal(h.attempts, 30, "aggregate attempt count is never capped");
  assert.ok(h.recentAttempts.length <= L.CONFIG.maxRecentAttempts, "detailed history is capped for storage");
  assert.equal(h.recentAttempts[h.recentAttempts.length - 1].attemptNumber, 30, "ring buffer keeps the most recent attempts");
});

/* ================= State classification: simple streak model ================= */

test("brand new (unattempted) word is state 'new'", () => {
  const h = L.createEmptyWordHistory("never-tested", 4, 12);
  assert.equal(L.classifyState(h), "new");
});

test("a wrong answer is state 'incorrect'", () => {
  const h = L.createEmptyWordHistory("hard", 4, 4);
  L.recordAttempt(h, { correct: false, responseMs: 1000, timestamp: 1000 });
  assert.equal(L.classifyState(h), "incorrect");
});

test("one correct answer (streak 1) is 'learning', not yet 'memorized'", () => {
  const h = L.createEmptyWordHistory("go", 4, 2);
  L.recordAttempt(h, { correct: true, responseMs: 400, timestamp: 1000 });
  assert.equal(L.classifyState(h), "learning");
});

test("two consecutive correct answers reach 'memorized'", () => {
  const h = L.createEmptyWordHistory("bat", 4, 3);
  play(h, [{ correct: true }, { correct: true }]);
  assert.equal(L.classifyState(h), "memorized");
});

test("a broken streak resets: memorized -> wrong answer -> back to 'incorrect', not just knocked down a notch", () => {
  const h = L.createEmptyWordHistory("cup", 4, 3);
  play(h, [{ correct: true }, { correct: true }]);
  assert.equal(L.classifyState(h), "memorized");
  play(h, [{ correct: false }]);
  assert.equal(L.classifyState(h), "incorrect");
  assert.equal(h.correctStreak, 0);
});

test("recovering after a reset still needs a fresh 2-streak, not credit for old attempts", () => {
  const h = L.createEmptyWordHistory("dog", 4, 3);
  play(h, [{ correct: true }, { correct: true }, { correct: false }, { correct: true }]);
  assert.equal(L.classifyState(h), "learning", "only 1 correct since the reset - not memorized yet");
  play(h, [{ correct: true }]);
  assert.equal(L.classifyState(h), "memorized");
});

test("a long, slowly-typed word and a short, quickly-typed word both reach Memorized on the same 2-streak rule - the label is length/time independent", () => {
  const shortWord = L.createEmptyWordHistory("cat", 4, 3);
  play(shortWord, [{ correct: true, responseMs: 400 }, { correct: true, responseMs: 380 }]);

  const longWord = L.createEmptyWordHistory("internationalization", 6, 21);
  play(longWord, [{ correct: true, responseMs: 9000 }, { correct: true, responseMs: 9500 }]);

  assert.equal(L.classifyState(shortWord), "memorized");
  assert.equal(L.classifyState(longWord), "memorized");
});

/* ================= Wrong-answer review data ================= */

test("recentWrongAnswersOf returns distinct past wrong answers, most recent first, capped", () => {
  const h = L.createEmptyWordHistory("weird", 4, 5);
  play(h, [
    { correct: false, answer: "wierd" },
    { correct: true },
    { correct: false, answer: "werid" },
    { correct: false, answer: "wierd" }, // repeat of the first mistake
    { correct: false, answer: "weerd" },
  ]);
  const recent = L.recentWrongAnswersOf(h, 3);
  assert.deepEqual(recent, ["weerd", "wierd", "werid"], "most recent first, de-duplicated, capped at 3");
});

test("recentWrongAnswersOf is empty for a word with no wrong answers yet", () => {
  const h = L.createEmptyWordHistory("easy", 4, 4);
  play(h, [{ correct: true }]);
  assert.deepEqual(L.recentWrongAnswersOf(h), []);
});

test("diffChars highlights a one-letter swap between the typed answer and the correct spelling", () => {
  const ops = L.diffChars("wierd", "weird");
  const correctChars = ops.map((o) => o.char).join("");
  assert.equal(correctChars, "weird", "diff is aligned against the correct word's letters");
  assert.ok(ops.some((o) => !o.match), "at least one letter should be flagged as not matched given the swap");
});

test("diffChars marks every letter matched for an exact match", () => {
  const ops = L.diffChars("weird", "weird");
  assert.ok(ops.every((o) => o.match));
});

/* ================= Review-priority weighting (time-based) ================= */

test("computeGlobalAverageResponseMs averages avgCorrectResponseMs across all words with timing data", () => {
  const historyStore = {};
  const a = L.createEmptyWordHistory("a", 4, 1);
  play(a, [{ correct: true, responseMs: 1000 }]);
  historyStore.a = a;
  const b = L.createEmptyWordHistory("b", 4, 1);
  play(b, [{ correct: true, responseMs: 2000 }]);
  historyStore.b = b;
  assert.equal(L.computeGlobalAverageResponseMs(historyStore), 1500);
});

test("computeGlobalAverageResponseMs is null when there is no timing data yet", () => {
  assert.equal(L.computeGlobalAverageResponseMs({}), null);
});

test("reviewPriorityWeight gives a word slower than the user's overall average a higher weight than one faster than average", () => {
  const now = 1000000;
  const globalAvg = 1000;
  const slowWord = { avgCorrectResponseMs: 2000, lastSeen: now - 5 * 24 * 60 * 60 * 1000 };
  const fastWord = { avgCorrectResponseMs: 500, lastSeen: now - 5 * 24 * 60 * 60 * 1000 };
  const slowWeight = L.reviewPriorityWeight(slowWord, globalAvg, now);
  const fastWeight = L.reviewPriorityWeight(fastWord, globalAvg, now);
  assert.ok(slowWeight > fastWeight, `slower-than-average word should weigh more (slow=${slowWeight}, fast=${fastWeight})`);
});

test("reviewPriorityWeight temporarily suppresses a word tested moments ago vs the same word tested long ago", () => {
  const now = 1000000;
  const wordInfo = { avgCorrectResponseMs: 2000 };
  const justTested = L.reviewPriorityWeight(Object.assign({}, wordInfo, { lastSeen: now - 1000 }), 1000, now);
  const testedDaysAgo = L.reviewPriorityWeight(Object.assign({}, wordInfo, { lastSeen: now - 10 * 24 * 60 * 60 * 1000 }), 1000, now);
  assert.ok(testedDaysAgo > justTested, "a word tested moments ago should be less eager to repeat than the same word tested days ago");
});

test("reviewPriorityWeight falls back to a neutral weight when there's no timing data yet for the word", () => {
  const w = L.reviewPriorityWeight({ lastSeen: 0 }, 1000, 1000000);
  assert.ok(w > 0);
});

test("weightedShuffle picks the higher-weight item first far more often than chance, but not every single time", () => {
  const items = ["slow", "fast"];
  const weights = [3.0, 0.3];
  // One generator reused across all trials (not reseeded per trial): a
  // freshly-seeded LCG's very first draw is biased toward 0 for small
  // sequential seeds, which would otherwise skew a test this sensitive.
  const rnd = seededRandom(42);
  let slowFirstCount = 0;
  const trials = 300;
  for (let i = 0; i < trials; i++) {
    const ordered = L.weightedShuffle(items, weights, rnd);
    if (ordered[0] === "slow") slowFirstCount += 1;
  }
  const rate = slowFirstCount / trials;
  assert.ok(rate > 0.7, `slower item should win the vast majority of draws (rate=${rate})`);
  assert.ok(rate < 1, "it should not be a rigid, deterministic guarantee every single trial");
});

/* ================= Question selection: 80/10/10 regular test ================= */

test("computeTestTargets scales the 80/10/10 ratio to arbitrary sizes", () => {
  assert.deepEqual(L.computeTestTargets(80), { new: 64, incorrect: 8, learning: 8 });
  const t20 = L.computeTestTargets(20);
  assert.equal(t20.new + t20.incorrect + t20.learning, 20);
  assert.equal(t20.new, 16);
});

test("selectTestQuestions hits the target 80/10/10 mix when all categories have ample supply", () => {
  const historyStore = {};
  const newWords = makePool(200, 4, "new");
  const incorrectWords = makePool(50, 5, "bad");
  const learningWords = makePool(50, 6, "mid");

  for (const w of incorrectWords) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 1200, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  for (const w of learningWords) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: true, responseMs: 1200, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }

  const pool = newWords.concat(incorrectWords, learningWords);
  const selection = L.selectTestQuestions({ pool, historyStore, size: 80, random: seededRandom(42) });

  assert.equal(selection.length, 80);
  const cats = L.categorizeWords(selection, historyStore);
  assert.equal(cats.unseen.length, 64);
  assert.equal(cats.incorrect.length, 8);
  assert.equal(cats.learning.length, 8);
});

test("selectTestQuestions never duplicates a word within one test", () => {
  const historyStore = {};
  const pool = makePool(100, 4, "u");
  for (let i = 0; i < 30; i++) {
    const w = pool[i];
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: i % 2 === 0, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const selection = L.selectTestQuestions({ pool, historyStore, size: 80, random: seededRandom(7) });
  const words = selection.map((w) => w.word.toLowerCase());
  assert.equal(new Set(words).size, words.length);
});

test("selectTestQuestions falls back intelligently when a category is short on candidates", () => {
  const historyStore = {};
  const pool = makePool(90, 4, "u");
  const incorrectFew = pool.slice(0, 2);
  const learningFew = pool.slice(2, 3);
  for (const w of incorrectFew) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  for (const w of learningFew) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: true, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }

  const selection = L.selectTestQuestions({ pool, historyStore, size: 80, random: seededRandom(3) });
  assert.equal(selection.length, 80, "shortfall in one category should be made up elsewhere, not shrink the test");
  const words = new Set(selection.map((w) => w.word.toLowerCase()));
  assert.equal(words.size, 80);
});

test("selectTestQuestions returns at most the pool size when the pool itself is smaller than requested", () => {
  const pool = makePool(15, 4, "tiny");
  const selection = L.selectTestQuestions({ pool, historyStore: {}, size: 80, random: seededRandom(1) });
  assert.equal(selection.length, 15);
  assert.equal(new Set(selection.map((w) => w.word)).size, 15);
});

test("selectTestQuestions excludes Memorized words entirely - they've graduated out of the rotation", () => {
  const historyStore = {};
  const memorizedWord = makeWord("done", 4);
  const h = L.createEmptyWordHistory("done", 4, 4);
  play(h, [{ correct: true }, { correct: true }]);
  historyStore.done = h;

  const pool = [memorizedWord];
  const selection = L.selectTestQuestions({ pool, historyStore, size: 80, random: seededRandom(5) });
  assert.equal(selection.length, 0, "the only word in the pool is Memorized, so there is nothing left to select");
});

/* ================= Question selection: 70/30 Review Test ================= */

test("computeReviewTargets scales the 70/30 ratio to arbitrary sizes", () => {
  assert.deepEqual(L.computeReviewTargets(20), { incorrect: 14, learning: 6 });
  assert.deepEqual(L.computeReviewTargets(10), { incorrect: 7, learning: 3 });
});

test("buildReviewTestList hits the 70/30 incorrect/learning mix when both have ample supply", () => {
  const historyStore = {};
  const incorrectWords = makePool(50, 4, "bad");
  const learningWords = makePool(50, 5, "mid");
  for (const w of incorrectWords) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 1000, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  for (const w of learningWords) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: true, responseMs: 1000, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const pool = incorrectWords.concat(learningWords);
  const selection = L.buildReviewTestList({ pool, historyStore, size: 20, random: seededRandom(11) });
  assert.equal(selection.length, 20);
  const cats = L.categorizeWords(selection, historyStore);
  assert.equal(cats.incorrect.length, 14);
  assert.equal(cats.learning.length, 6);
});

test("buildReviewTestList falls back between incorrect and learning when one category is short", () => {
  const historyStore = {};
  const pool = makePool(30, 4, "u");
  const incorrectFew = pool.slice(0, 2);
  const learningMany = pool.slice(2, 30);
  for (const w of incorrectFew) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  for (const w of learningMany) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: true, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const selection = L.buildReviewTestList({ pool, historyStore, size: 20, random: seededRandom(4) });
  assert.equal(selection.length, 20, "shortfall in incorrect should be made up from learning");
});

test("buildReviewTestList respects a custom user-chosen size", () => {
  const historyStore = {};
  const pool = makePool(30, 4, "u");
  for (const w of pool) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const selection = L.buildReviewTestList({ pool, historyStore, size: 5, random: seededRandom(2) });
  assert.equal(selection.length, 5);
});

test("buildReviewTestList size=0 means 'all available'", () => {
  const historyStore = {};
  const pool = makePool(7, 4, "u");
  for (const w of pool) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const selection = L.buildReviewTestList({ pool, historyStore, size: 0, random: seededRandom(2) });
  assert.equal(selection.length, 7);
});

test("buildReviewTestList with no size given defaults to CONFIG.defaultReviewSize, capped to what's available", () => {
  const historyStore = {};
  const pool = makePool(200, 4, "u");
  for (const w of pool) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const selection = L.buildReviewTestList({ pool, historyStore, random: seededRandom(2) });
  assert.equal(selection.length, L.CONFIG.defaultReviewSize);
});

test("buildReviewTestList excludes Memorized and never-attempted words", () => {
  const historyStore = {};
  const memorizedWord = makeWord("done", 4);
  const h = L.createEmptyWordHistory("done", 4, 4);
  play(h, [{ correct: true }, { correct: true }]);
  historyStore.done = h;

  const newWord = makeWord("fresh", 4); // never attempted, no history entry at all

  const selection = L.buildReviewTestList({ pool: [memorizedWord, newWord], historyStore, random: seededRandom(1) });
  assert.equal(selection.length, 0);
});

test("buildReviewTestList returns an empty list (not an error) when nothing needs review", () => {
  const selection = L.buildReviewTestList({ pool: makePool(5, 4, "x"), historyStore: {}, random: seededRandom(1) });
  assert.deepEqual(selection, []);
});

/* ================= Persistence / migration / backward compatibility ================= */

test("migrateWordEntry upgrades legacy v1 {box,due,correct,wrong,lastSeen} shape without losing progress", () => {
  const legacy = { box: 3, due: 123456, correct: 5, wrong: 2, lastSeen: 999000 };
  const migrated = L.migrateWordEntry(legacy, "legacy", 5, 6);
  assert.equal(migrated.attempts, 7);
  assert.equal(migrated.correct, 5);
  assert.equal(migrated.incorrect, 2);
  assert.equal(migrated.lastSeen, 999000);
  assert.equal(migrated.word, "legacy");
  assert.equal(migrated.level, 5);
  assert.equal(migrated.lastWrongAnswer, null);
  assert.ok(Array.isArray(migrated.recentAttempts));
});

test("migrateWordEntry upgrades an intermediate score-based v2 entry, dropping unused fields harmlessly", () => {
  const scoreEraEntry = {
    word: "keep", level: 4, length: 4, attempts: 3, correct: 2, incorrect: 1, correctStreak: 0,
    avgCorrectResponseMs: 1200, recentResponseMs: 1300, recentAttempts: [], firstSeen: 100, lastSeen: 200,
    lastResult: "incorrect", inWrongList: true, box: 0, due: 0,
  };
  const migrated = L.migrateWordEntry(scoreEraEntry, "keep", 4, 4);
  assert.equal(migrated.attempts, 3);
  assert.equal(migrated.correct, 2);
  assert.equal(L.classifyState(migrated), "incorrect");
});

test("migrateWordEntry is idempotent on an already-current entry and fills any newly-added defaults", () => {
  const current = L.createEmptyWordHistory("keepme", 4, 6);
  L.recordAttempt(current, { correct: true, responseMs: 1000, timestamp: 1000, level: 4, length: 6 });
  const remigrated = L.migrateWordEntry(current, "keepme", 4, 6);
  assert.equal(remigrated.attempts, current.attempts);
  assert.equal(remigrated.correct, current.correct);
  assert.deepEqual(remigrated.recentAttempts, current.recentAttempts);
});

test("migrateProgressStore migrates an entire legacy store and preserves per-word data", () => {
  const legacyStore = {
    abandon: { box: 5, due: 111, correct: 4, wrong: 0, lastSeen: 5000 },
    zebra: { box: 0, due: 0, correct: 0, wrong: 1, lastSeen: 6000 },
  };
  const vocabIndex = {
    abandon: { word: "abandon", level: 4 },
    zebra: { word: "zebra", level: 6 },
  };
  const migrated = L.migrateProgressStore(legacyStore, vocabIndex);
  assert.equal(migrated.abandon.attempts, 4);
  assert.equal(migrated.abandon.level, 4);
  assert.equal(migrated.zebra.incorrect, 1);
  assert.equal(L.classifyState(migrated.zebra), "incorrect");
});

test("migrateProgressStore on an empty/missing store returns an empty object, not an error", () => {
  assert.deepEqual(L.migrateProgressStore(null, {}), {});
  assert.deepEqual(L.migrateProgressStore(undefined, {}), {});
});

test("a word's history survives a JSON save/reload round-trip with identical state classification", () => {
  const h = L.createEmptyWordHistory("persist", 4, 7);
  play(h, [{ correct: true }, { correct: false, answer: "persits" }, { correct: true }]);
  const reloaded = JSON.parse(JSON.stringify(h));
  assert.equal(L.classifyState(reloaded), L.classifyState(h));
  assert.equal(reloaded.lastWrongAnswer, "persits");
});

/* ================= Progress summary ================= */

test("computeProgressSummary reports counts by state and by level, plus overall accuracy", () => {
  const historyStore = {};
  const pool = [makeWord("a", 4), makeWord("b", 4), makeWord("c", 5)];

  const ha = L.createEmptyWordHistory("a", 4, 1);
  play(ha, [{ correct: true }, { correct: true }]);
  historyStore.a = ha;

  const hb = L.createEmptyWordHistory("b", 4, 1);
  L.recordAttempt(hb, { correct: false, responseMs: 1000, timestamp: 1000, level: 4, length: 1 });
  historyStore.b = hb;
  // "c" stays unattempted -> new

  const summary = L.computeProgressSummary(pool, historyStore);
  assert.equal(summary.totalWords, 3);
  assert.equal(summary.totalEncountered, 2);
  assert.equal(summary.counts.new, 1);
  assert.equal(summary.counts.memorized, 1);
  assert.equal(summary.counts.incorrect, 1);
  assert.equal(summary.byLevel[4].total, 2);
  assert.equal(summary.byLevel[5].total, 1);
  assert.ok(summary.overallAccuracy > 0 && summary.overallAccuracy < 1);
});

test("computeWordDetail exposes streak, wrong-answer history, and state for the Progress word list", () => {
  const historyStore = {};
  const w = makeWord("detail", 5);
  const h = L.createEmptyWordHistory("detail", 5, 6);
  play(h, [{ correct: false, answer: "detial" }, { correct: true, responseMs: 1500 }]);
  historyStore.detail = h;

  const detail = L.computeWordDetail(w, historyStore);
  assert.equal(detail.word, "detail");
  assert.equal(detail.level, 5);
  assert.equal(detail.attempts, 2);
  assert.equal(detail.correct, 1);
  assert.equal(detail.correctStreak, 1);
  assert.equal(detail.lastWrongAnswer, "detial");
  assert.deepEqual(detail.recentWrongAnswers, ["detial"]);
  assert.equal(detail.state, "learning");
});
