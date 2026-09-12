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

test("reviewPriorityWeight gives a word slower than its length-expected baseline a higher weight than one faster than expected", () => {
  const now = 1000000;
  const baseline = { predict: () => 1000 }; // flat baseline, same as the old flat-average shape
  const slowWord = { avgCorrectResponseMs: 2000, lastSeen: now - 5 * 24 * 60 * 60 * 1000 };
  const fastWord = { avgCorrectResponseMs: 500, lastSeen: now - 5 * 24 * 60 * 60 * 1000 };
  const slowWeight = L.reviewPriorityWeight(slowWord, baseline, now);
  const fastWeight = L.reviewPriorityWeight(fastWord, baseline, now);
  assert.ok(slowWeight > fastWeight, `slower-than-expected word should weigh more (slow=${slowWeight}, fast=${fastWeight})`);
});

test("reviewPriorityWeight temporarily suppresses a word tested moments ago vs the same word tested long ago", () => {
  const now = 1000000;
  const baseline = { predict: () => 1000 };
  const wordInfo = { avgCorrectResponseMs: 2000 };
  const justTested = L.reviewPriorityWeight(Object.assign({}, wordInfo, { lastSeen: now - 1000 }), baseline, now);
  const testedDaysAgo = L.reviewPriorityWeight(Object.assign({}, wordInfo, { lastSeen: now - 10 * 24 * 60 * 60 * 1000 }), baseline, now);
  assert.ok(testedDaysAgo > justTested, "a word tested moments ago should be less eager to repeat than the same word tested days ago");
});

test("reviewPriorityWeight falls back to a neutral weight when there's no timing data yet for the word", () => {
  const w = L.reviewPriorityWeight({ lastSeen: 0 }, { predict: () => 1000 }, 1000000);
  assert.ok(w > 0);
});

test("reviewPriorityWeight falls back to a neutral weight when there's no baseline at all yet (nobody has any timing data)", () => {
  const w = L.reviewPriorityWeight({ avgCorrectResponseMs: 5000, lastSeen: 500000 }, null, 1000000);
  assert.ok(w > 0);
});

/* ================= Length-aware response time baseline (fixes long words always reading as "slow") ================= */

test("computeResponseTimeBaseline is null with no timing data at all", () => {
  assert.equal(L.computeResponseTimeBaseline({}), null);
});

test("computeResponseTimeBaseline falls back to a flat overall average below the min-sample threshold, regardless of length", () => {
  const historyStore = {};
  // Only 3 points (well under CONFIG.minSamplesForLengthTrend) - too few to
  // trust a fitted length trend, so every length should predict the same
  // flat average.
  const words = [
    { word: "a", length: 2, ms: 800 },
    { word: "extraordinary", length: 13, ms: 2200 },
    { word: "cat", length: 3, ms: 1200 },
  ];
  for (const w of words) {
    const h = L.createEmptyWordHistory(w.word, 4, w.length);
    L.recordAttempt(h, { correct: true, responseMs: w.ms, timestamp: 1000, level: 4, length: w.length });
    historyStore[w.word] = h;
  }
  const baseline = L.computeResponseTimeBaseline(historyStore);
  assert.ok(baseline);
  const expectedFlatAvg = (800 + 2200 + 1200) / 3;
  assert.equal(baseline.predict(2), expectedFlatAvg);
  assert.equal(baseline.predict(13), expectedFlatAvg);
});

test("computeResponseTimeBaseline predicts a longer expected time for longer words once there's enough data to fit a trend", () => {
  const historyStore = {};
  // 10 synthetic words with response time scaling cleanly with length
  // (500ms base + 150ms per character) - well over minSamplesForLengthTrend
  // (8), so this should fit a real length trend instead of falling back to
  // one flat average.
  for (let len = 3; len <= 12; len++) {
    const word = "w".repeat(len);
    const h = L.createEmptyWordHistory(word, 4, len);
    const ms = 500 + len * 150;
    L.recordAttempt(h, { correct: true, responseMs: ms, timestamp: 1000, level: 4, length: len });
    historyStore[word] = h;
  }
  const baseline = L.computeResponseTimeBaseline(historyStore);
  assert.ok(baseline);
  assert.ok(
    baseline.predict(12) > baseline.predict(4),
    "a longer word should have a higher expected time than a shorter one once a trend is fitted"
  );
});

test("relativeResponseTime: a long word exactly on pace for its own length is neutral (~1), not flagged 'slow' just for being long", () => {
  const historyStore = {};
  // A range of word lengths, each answered in EXACTLY the length-scaled
  // "expected" time (500 + 150*len) - nobody here is actually struggling,
  // long or short, they're all equally well-practiced relative to their
  // own word's length.
  for (let len = 3; len <= 14; len++) {
    const word = "w".repeat(len);
    const h = L.createEmptyWordHistory(word, 4, len);
    const ms = 500 + len * 150;
    L.recordAttempt(h, { correct: true, responseMs: ms, timestamp: 1000, level: 4, length: len });
    historyStore[word] = h;
  }
  const baseline = L.computeResponseTimeBaseline(historyStore);
  const longWordHistory = historyStore["w".repeat(14)];
  const shortWordHistory = historyStore["w".repeat(3)];
  const longRel = L.relativeResponseTime(longWordHistory, baseline);
  const shortRel = L.relativeResponseTime(shortWordHistory, baseline);
  assert.ok(Math.abs(longRel - 1) < 0.05, `a long word right on pace for its length should be ~1, got ${longRel}`);
  assert.ok(Math.abs(shortRel - 1) < 0.05, `a short word right on pace for its length should be ~1, got ${shortRel}`);
});

test("selectQuestions no longer systematically favors long words for review just because they take longer to type", () => {
  const historyStore = {};
  const now = 1000;
  // 20 "learning" words of varying length, EVERY ONE answered exactly on
  // pace for its own length (500 + 150*len) - none of them is actually
  // weaker than any other. Under the old flat-global-average comparison,
  // every long word here would still be pegged as "slower than average"
  // (since the average is dominated by shorter/mid-length words) and long
  // words would dominate weighted selection; under the length-aware
  // baseline none of them should be systematically favored over another.
  const words = [];
  for (let len = 3; len <= 22; len++) {
    const word = "w".repeat(len);
    words.push({ word: word, pos: "n.", level: 4, zh: "測試" });
    const h = L.createEmptyWordHistory(word, 4, len);
    L.recordAttempt(h, { correct: true, responseMs: 500 + len * 150, timestamp: now, level: 4, length: len });
    historyStore[word.toLowerCase()] = h;
  }
  // Draw many independent weighted rankings and tally how often the
  // longest word (len=22) lands ahead of the shortest (len=3).
  let longFirstCount = 0;
  const trials = 300;
  for (let seed = 1; seed <= trials; seed++) {
    const ranked = L.selectQuestions({
      pool: words,
      historyStore,
      size: words.length,
      ratio: { new: 0, incorrect: 0, learning: 1 },
      random: seededRandom(seed),
      now,
    });
    const longIdx = ranked.findIndex((w) => w.word === "w".repeat(22));
    const shortIdx = ranked.findIndex((w) => w.word === "w".repeat(3));
    if (longIdx < shortIdx) longFirstCount += 1;
  }
  const rate = longFirstCount / trials;
  assert.ok(rate > 0.35 && rate < 0.65, `the long word should not dominate the front of the list just for being long (rate=${rate})`);
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

/* ================= Question selection: one ratio-driven mode ================= */

test("computeQuestionTargets scales the default 80/10/10 ratio to arbitrary sizes, summing exactly to size", () => {
  assert.deepEqual(L.computeQuestionTargets(80, L.CONFIG.defaultQuestionRatio), { new: 64, incorrect: 8, learning: 8 });
  const t20 = L.computeQuestionTargets(20, L.CONFIG.defaultQuestionRatio);
  assert.equal(t20.new + t20.incorrect + t20.learning, 20);
  assert.equal(t20.new, 16);
});

test("computeQuestionTargets normalizes a ratio that doesn't sum to 1 and still sums exactly to size", () => {
  // A user-dragged slider ratio like {70,30,0} out of 100 - percentages,
  // not fractions - should normalize the same as a fractional one.
  const t = L.computeQuestionTargets(20, { new: 0, incorrect: 70, learning: 30 });
  assert.equal(t.new + t.incorrect + t.learning, 20);
  assert.equal(t.incorrect, 14);
  assert.equal(t.learning, 6);
});

test("selectQuestions hits the default 80/10/10 mix when all categories have ample supply", () => {
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
  const selection = L.selectQuestions({ pool, historyStore, size: 80, random: seededRandom(42) });

  assert.equal(selection.length, 80);
  const cats = L.categorizeWords(selection, historyStore);
  assert.equal(cats.unseen.length, 64);
  assert.equal(cats.incorrect.length, 8);
  assert.equal(cats.learning.length, 8);
});

test("selectQuestions honors a custom ratio - e.g. the old Review Test's 70/30 incorrect/learning, no new words", () => {
  const historyStore = {};
  const incorrectWords = makePool(50, 4, "bad");
  const learningWords = makePool(50, 5, "mid");
  const newWords = makePool(50, 6, "new");
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
  const pool = incorrectWords.concat(learningWords, newWords);
  const selection = L.selectQuestions({
    pool,
    historyStore,
    size: 20,
    ratio: { new: 0, incorrect: 0.7, learning: 0.3 },
    random: seededRandom(11),
  });
  assert.equal(selection.length, 20);
  const cats = L.categorizeWords(selection, historyStore);
  assert.equal(cats.incorrect.length, 14);
  assert.equal(cats.learning.length, 6);
  assert.equal(cats.unseen.length, 0, "new words must never appear when their ratio slider is 0%");
});

test("selectQuestions never duplicates a word within one round", () => {
  const historyStore = {};
  const pool = makePool(100, 4, "u");
  for (let i = 0; i < 30; i++) {
    const w = pool[i];
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: i % 2 === 0, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const selection = L.selectQuestions({ pool, historyStore, size: 80, random: seededRandom(7) });
  const words = selection.map((w) => w.word.toLowerCase());
  assert.equal(new Set(words).size, words.length);
});

test("selectQuestions falls back intelligently (within non-zero-ratio categories) when one is short on candidates", () => {
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

  const selection = L.selectQuestions({ pool, historyStore, size: 80, random: seededRandom(3) });
  assert.equal(selection.length, 80, "shortfall in one category should be made up elsewhere, not shrink the round");
  const words = new Set(selection.map((w) => w.word.toLowerCase()));
  assert.equal(words.size, 80);
});

test("selectQuestions never redistributes a shortfall into a category whose ratio is 0%", () => {
  const historyStore = {};
  // Only 2 incorrect words exist, but incorrect's ratio is 100% and every
  // other category is 0% - it must NOT fall back to filling the rest from
  // new/learning just because they have supply; that would silently ignore
  // the user's explicit "review only" choice.
  const pool = makePool(90, 4, "u");
  const incorrectFew = pool.slice(0, 2);
  for (const w of incorrectFew) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const selection = L.selectQuestions({
    pool,
    historyStore,
    size: 80,
    ratio: { new: 0, incorrect: 1, learning: 0 },
    random: seededRandom(3),
  });
  assert.equal(selection.length, 2, "only the 2 genuinely-incorrect words should come back, not padded from other categories");
});

test("selectQuestions returns at most the pool size when the pool itself is smaller than requested", () => {
  const pool = makePool(15, 4, "tiny");
  const selection = L.selectQuestions({ pool, historyStore: {}, size: 80, random: seededRandom(1) });
  assert.equal(selection.length, 15);
  assert.equal(new Set(selection.map((w) => w.word)).size, 15);
});

test("selectQuestions excludes Memorized words entirely - they've graduated out of the rotation", () => {
  const historyStore = {};
  const memorizedWord = makeWord("done", 4);
  const h = L.createEmptyWordHistory("done", 4, 4);
  play(h, [{ correct: true }, { correct: true }]);
  historyStore.done = h;

  const pool = [memorizedWord];
  const selection = L.selectQuestions({ pool, historyStore, size: 80, random: seededRandom(5) });
  assert.equal(selection.length, 0, "the only word in the pool is Memorized, so there is nothing left to select");
});

test("selectQuestions returns an empty list (not an error) when every ratio slider is 0%", () => {
  const selection = L.selectQuestions({
    pool: makePool(5, 4, "x"),
    historyStore: {},
    ratio: { new: 0, incorrect: 0, learning: 0 },
    random: seededRandom(1),
  });
  assert.deepEqual(selection, []);
});

/* ================= Auto-balance mode ratio ================= */

test("computeAutoBalanceRatio is all-new when there is no review backlog at all", () => {
  const ratio = L.computeAutoBalanceRatio({ new: 300, incorrect: 0, learning: 0 });
  assert.deepEqual(ratio, { new: 1, incorrect: 0, learning: 0 });
});

test("computeAutoBalanceRatio is all-review once there are no new words left to introduce", () => {
  const ratio = L.computeAutoBalanceRatio({ new: 0, incorrect: 10, learning: 5 });
  assert.equal(ratio.new, 0);
  assert.ok(ratio.incorrect > 0 && ratio.learning > 0);
  assert.ok(Math.abs(ratio.incorrect + ratio.learning - 1) < 1e-9);
});

test("computeAutoBalanceRatio never goes to a flat equal three-way split - review share scales with backlog size, not a fixed target", () => {
  const smallBacklog = L.computeAutoBalanceRatio({ new: 500, incorrect: 2, learning: 1 });
  const bigBacklog = L.computeAutoBalanceRatio({ new: 500, incorrect: 200, learning: 100 });
  assert.ok(smallBacklog.new > 0.8, "a tiny backlog against a huge new-word pool should stay mostly new words");
  assert.ok(bigBacklog.new < smallBacklog.new, "a much bigger backlog should pull review share up (and new share down)");
  // Never fully saturates to 0% new even under a very heavy backlog - some
  // new words should always keep trickling in.
  assert.ok(bigBacklog.new > 0);
});

test("computeAutoBalanceRatio leans the review share toward incorrect over learning at equal counts", () => {
  const ratio = L.computeAutoBalanceRatio({ new: 100, incorrect: 10, learning: 10 });
  assert.ok(ratio.incorrect > ratio.learning, "still-wrong words should get more of the review share than almost-there words");
});

test("computeAutoBalanceRatio's three shares always sum to 1 across a range of counts", () => {
  const cases = [
    { new: 0, incorrect: 0, learning: 0 },
    { new: 50, incorrect: 0, learning: 0 },
    { new: 0, incorrect: 5, learning: 0 },
    { new: 0, incorrect: 0, learning: 5 },
    { new: 20, incorrect: 20, learning: 20 },
    { new: 1000, incorrect: 3, learning: 400 },
  ];
  for (const c of cases) {
    const r = L.computeAutoBalanceRatio(c);
    assert.ok(Math.abs(r.new + r.incorrect + r.learning - 1) < 1e-9, JSON.stringify(c));
  }
});

test("computeAutoBalanceRatioForPool derives counts from a pool + historyStore, matching computeAutoBalanceRatio on those counts", () => {
  const historyStore = {};
  const incorrectWords = makePool(10, 4, "bad");
  const learningWords = makePool(5, 5, "mid");
  const newWords = makePool(100, 6, "new");
  for (const w of incorrectWords) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  for (const w of learningWords) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: true, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  const pool = incorrectWords.concat(learningWords, newWords);
  const fromPool = L.computeAutoBalanceRatioForPool(pool, historyStore);
  const direct = L.computeAutoBalanceRatio({ new: 100, incorrect: 10, learning: 5 });
  assert.deepEqual(fromPool, direct);
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
