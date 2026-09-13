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

test("diffCharsBoth flags the mismatched letters on BOTH sides for a one-letter swap, not just the correct spelling", () => {
  const { typed, correct } = L.diffCharsBoth("wierd", "weird");
  assert.equal(typed.map((o) => o.char).join(""), "wierd", "typed-side is aligned against what the user actually typed");
  assert.equal(correct.map((o) => o.char).join(""), "weird", "correct-side is aligned against the correct spelling");
  assert.ok(typed.some((o) => !o.match), "the misplaced letter in what was typed should be flagged");
  assert.ok(correct.some((o) => !o.match), "the letter missing from its expected spot should be flagged");
});

test("diffCharsBoth flags a trailing extra letter as unmatched on the typed side only", () => {
  const { typed, correct } = L.diffCharsBoth("catss", "cats");
  assert.equal(typed.map((o) => o.char).join(""), "catss");
  assert.equal(correct.map((o) => o.char).join(""), "cats");
  assert.ok(correct.every((o) => o.match), "every correct letter was in fact typed");
  assert.equal(typed.filter((o) => !o.match).length, 1, "only the one extra trailing letter should be flagged");
});

test("diffCharsBoth marks every letter matched on both sides for an exact match", () => {
  const { typed, correct } = L.diffCharsBoth("weird", "weird");
  assert.ok(typed.every((o) => o.match) && correct.every((o) => o.match));
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

test("computeSelectionWeight gives a word slower than its length-expected baseline a higher weight than one faster than expected", () => {
  const now = 1000000;
  const models = { difficultyBaseline: null, interferenceModel: null, responseTimeBaseline: { predict: () => 1000 } };
  const slowWord = { word: "slow", level: 4 };
  const fastWord = { word: "fast", level: 4 };
  const slowHistory = { avgCorrectResponseMs: 2000, lastSeen: now - 5 * 24 * 60 * 60 * 1000 };
  const fastHistory = { avgCorrectResponseMs: 500, lastSeen: now - 5 * 24 * 60 * 60 * 1000 };
  const slowWeight = L.computeSelectionWeight(slowWord, slowHistory, models, now);
  const fastWeight = L.computeSelectionWeight(fastWord, fastHistory, models, now);
  assert.ok(slowWeight > fastWeight, `slower-than-expected word should weigh more (slow=${slowWeight}, fast=${fastWeight})`);
});

test("computeSelectionWeight temporarily suppresses a word tested moments ago vs the same word tested long ago", () => {
  const now = 1000000;
  const models = { difficultyBaseline: null, interferenceModel: null, responseTimeBaseline: { predict: () => 1000 } };
  const w = { word: "example", level: 4 };
  const justTested = L.computeSelectionWeight(w, { avgCorrectResponseMs: 2000, lastSeen: now - 1000 }, models, now);
  const testedDaysAgo = L.computeSelectionWeight(w, { avgCorrectResponseMs: 2000, lastSeen: now - 10 * 24 * 60 * 60 * 1000 }, models, now);
  assert.ok(testedDaysAgo > justTested, "a word tested moments ago should be less eager to repeat than the same word tested days ago");
});

test("computeSelectionWeight falls back to a neutral weight when there's no timing data yet for the word", () => {
  const models = { difficultyBaseline: null, interferenceModel: null, responseTimeBaseline: { predict: () => 1000 } };
  const weight = L.computeSelectionWeight({ word: "x", level: 4 }, { lastSeen: 0 }, models, 1000000);
  assert.ok(weight > 0);
});

test("computeSelectionWeight falls back to a neutral weight when there's no baseline at all yet (nobody has any timing data)", () => {
  const models = { difficultyBaseline: null, interferenceModel: null, responseTimeBaseline: null };
  const weight = L.computeSelectionWeight({ word: "x", level: 4 }, { avgCorrectResponseMs: 5000, lastSeen: 500000 }, models, 1000000);
  assert.ok(weight > 0);
});

test("computeSelectionWeight gives a word with a higher OWN empirical error rate a higher weight than one with a lower rate, all else equal", () => {
  const now = 1000000;
  const models = { difficultyBaseline: { predict: () => 0.2 }, interferenceModel: null, responseTimeBaseline: null };
  const w = { word: "example", level: 4 };
  const oftenWrong = L.computeSelectionWeight(w, { attempts: 10, incorrect: 9, lastSeen: now }, models, now);
  const rarelyWrong = L.computeSelectionWeight(w, { attempts: 10, incorrect: 1, lastSeen: now }, models, now);
  assert.ok(oftenWrong > rarelyWrong, "a word this user actually gets wrong most of the time should outweigh one they rarely miss");
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

/* ================= Manual "review this again" marking ================= */

test("setMarked flags a word and isMarked reflects it; unmarking clears it back to 0", () => {
  const h = L.createEmptyWordHistory("cat", 4, 3);
  assert.equal(L.isMarked(h), false);
  L.setMarked(h, true, 5000);
  assert.equal(h.markedAt, 5000);
  assert.equal(L.isMarked(h), true);
  L.setMarked(h, false);
  assert.equal(h.markedAt, 0);
  assert.equal(L.isMarked(h), false);
});

test("setMarked defaults the timestamp to now when marking without one", () => {
  const h = L.createEmptyWordHistory("cat", 4, 3);
  const before = Date.now();
  L.setMarked(h, true);
  assert.ok(h.markedAt >= before);
});

test("marking is independent of state - answering a marked word correctly does not un-mark it", () => {
  const h = L.createEmptyWordHistory("cat", 4, 3);
  L.setMarked(h, true, 1000);
  L.recordAttempt(h, { correct: true, responseMs: 500, timestamp: 2000 });
  L.recordAttempt(h, { correct: true, responseMs: 500, timestamp: 3000 });
  assert.equal(L.classifyState(h), "memorized");
  assert.equal(L.isMarked(h), true, "reaching Memorized must not silently clear a manual mark");
});

test("filterMarked returns only marked words, regardless of their state", () => {
  const historyStore = {};
  const pool = makePool(5, 4, "w");
  // w0: marked + never attempted (still "new"). w2: marked + memorized. Rest: unmarked.
  const h0 = L.createEmptyWordHistory("w0", 4, 2);
  L.setMarked(h0, true, 1000);
  historyStore.w0 = h0;

  const h2 = L.createEmptyWordHistory("w2", 4, 2);
  L.recordAttempt(h2, { correct: true, responseMs: 500, timestamp: 1000 });
  L.recordAttempt(h2, { correct: true, responseMs: 500, timestamp: 2000 });
  L.setMarked(h2, true, 3000);
  historyStore.w2 = h2;

  const h3 = L.createEmptyWordHistory("w3", 4, 2);
  L.recordAttempt(h3, { correct: false, responseMs: 500, timestamp: 1000 });
  historyStore.w3 = h3; // incorrect but NOT marked

  const marked = L.filterMarked(pool, historyStore);
  assert.deepEqual(marked.map((w) => w.word).sort(), ["w0", "w2"]);
});

test("computeWordDetail exposes marked/markedAt so the UI can render a star toggle", () => {
  const historyStore = {};
  const h = L.createEmptyWordHistory("cat", 4, 3);
  L.setMarked(h, true, 7000);
  historyStore.cat = h;
  const detail = L.computeWordDetail({ word: "cat", level: 4, pos: "n.", zh: "貓" }, historyStore);
  assert.equal(detail.marked, true);
  assert.equal(detail.markedAt, 7000);

  const unmarkedDetail = L.computeWordDetail({ word: "dog", level: 4, pos: "n.", zh: "狗" }, {});
  assert.equal(unmarkedDetail.marked, false);
  assert.equal(unmarkedDetail.markedAt, 0);
});

/* ================= Review batching (large-backlog sessions) ================= */

test("recordAttempt also updates lastReviewedAt, same as lastSeen - a quiz attempt counts as reviewing the word", () => {
  const h = L.createEmptyWordHistory("cat", 4, 3);
  assert.equal(h.lastReviewedAt, 0);
  L.recordAttempt(h, { correct: true, responseMs: 500, timestamp: 5000 });
  assert.equal(h.lastReviewedAt, 5000);
});

test("markReviewed sets lastReviewedAt without touching attempts/correctness", () => {
  const h = L.createEmptyWordHistory("cat", 4, 3);
  L.recordAttempt(h, { correct: false, responseMs: 500, timestamp: 1000 });
  L.markReviewed(h, 9000);
  assert.equal(h.lastReviewedAt, 9000);
  assert.equal(h.attempts, 1, "browsing a flashcard must never count as an attempt");
  assert.equal(h.lastResult, "incorrect", "must not touch correctness state");
});

test("markReviewed defaults the timestamp to now when none is given", () => {
  const h = L.createEmptyWordHistory("cat", 4, 3);
  const before = Date.now();
  L.markReviewed(h);
  assert.ok(h.lastReviewedAt >= before);
});

test("selectReviewBatch surfaces never-reviewed words before ones reviewed at all, regardless of pool order", () => {
  const historyStore = {};
  const pool = makePool(10, 4, "w");
  // Every word EXCEPT w7 has been reviewed recently - w7 should always win
  // a 1-word batch.
  for (const w of pool) {
    if (w.word === "w7") continue;
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.markReviewed(h, 500000);
    historyStore[w.word.toLowerCase()] = h;
  }
  const batch = L.selectReviewBatch(pool, historyStore, 1, seededRandom(1));
  assert.equal(batch.length, 1);
  assert.equal(batch[0].word, "w7");
});

test("selectReviewBatch orders strictly by lastReviewedAt ascending (oldest/never-reviewed first)", () => {
  const historyStore = {};
  const pool = makePool(6, 4, "w");
  const timestamps = [5000, 1000, 4000, 0, 3000, 2000]; // w0..w5
  pool.forEach((w, i) => {
    if (timestamps[i] === 0) return; // leave w3 at the default 0 (never reviewed)
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.markReviewed(h, timestamps[i]);
    historyStore[w.word.toLowerCase()] = h;
  });
  const batch = L.selectReviewBatch(pool, historyStore, 6, seededRandom(3));
  const order = batch.map((w) => w.word);
  assert.deepEqual(order, ["w3", "w1", "w5", "w4", "w2", "w0"]);
});

test("selectReviewBatch caps at the requested size and never duplicates a word", () => {
  const pool = makePool(50, 4, "w");
  const batch = L.selectReviewBatch(pool, {}, 20, seededRandom(7));
  assert.equal(batch.length, 20);
  assert.equal(new Set(batch.map((w) => w.word)).size, 20);
});

test("selectReviewBatch returns the whole pool (not padded/duplicated) when size exceeds it", () => {
  const pool = makePool(5, 4, "w");
  const batch = L.selectReviewBatch(pool, {}, 20, seededRandom(2));
  assert.equal(batch.length, 5);
  assert.equal(new Set(batch.map((w) => w.word)).size, 5);
});

test("selectReviewBatch randomizes order among words with the same lastReviewedAt (e.g. all never-reviewed) rather than always returning pool order", () => {
  const pool = makePool(30, 4, "w"); // none reviewed - all tied at 0
  const first = L.selectReviewBatch(pool, {}, 30, seededRandom(11)).map((w) => w.word);
  const second = L.selectReviewBatch(pool, {}, 30, seededRandom(12)).map((w) => w.word);
  assert.notDeepEqual(first, second, "two different random seeds should not produce the identical order every time");
});

/* ================= Predicting difficulty of never-attempted words ================= */

test("bigramsOf splits a word into consecutive letter pairs", () => {
  assert.deepEqual(L.bigramsOf("quiet"), ["qu", "ui", "ie", "et"]);
  assert.deepEqual(L.bigramsOf("a"), []);
});

test("bigramSimilarity is 1 for identical spelling, 0 for no shared letter-pairs, and in between for partial overlap", () => {
  assert.equal(L.bigramSimilarity("cat", "cat"), 1);
  assert.equal(L.bigramSimilarity("cat", "dog"), 0);
  // quiet=[qu,ui,ie,et], quiz=[qu,ui,iz] - share "qu","ui" (2 of a 5-bigram union)
  assert.ok(Math.abs(L.bigramSimilarity("quiet", "quiz") - 0.4) < 1e-9);
});

test("hasDoubledLetter finds an immediately-repeated letter, ignoring words without one", () => {
  assert.equal(L.hasDoubledLetter("occurred"), true);
  assert.equal(L.hasDoubledLetter("necessary"), true);
  assert.equal(L.hasDoubledLetter("cat"), false);
  assert.equal(L.hasDoubledLetter(""), false);
});

test("computeDifficultyBaseline is null with no attempted words at all", () => {
  assert.equal(L.computeDifficultyBaseline({}), null);
});

test("computeDifficultyBaseline falls back to a flat average below the min-sample threshold, regardless of length", () => {
  const historyStore = {};
  const rows = [
    { word: "ab", length: 2, attempts: 4, incorrect: 1, level: 4 }, // 25% error
    { word: "abcdefghij", length: 10, attempts: 4, incorrect: 3, level: 4 }, // 75% error
  ];
  for (const r of rows) {
    const h = L.createEmptyWordHistory(r.word, r.level, r.length);
    h.attempts = r.attempts;
    h.incorrect = r.incorrect;
    h.correct = r.attempts - r.incorrect;
    historyStore[r.word] = h;
  }
  const baseline = L.computeDifficultyBaseline(historyStore);
  assert.ok(baseline);
  const expectedFlat = (0.25 + 0.75) / 2;
  // Both rows share the same level, so the level-group average equals the
  // overall average and its shrunk deviation is exactly 0 either way.
  assert.ok(Math.abs(baseline.predict("ab", 4) - expectedFlat) < 1e-9);
  assert.ok(Math.abs(baseline.predict("abcdefghij", 4) - expectedFlat) < 1e-9);
});

test("computeDifficultyBaseline predicts a higher error rate for longer words once there's enough data to fit a real trend", () => {
  const historyStore = {};
  for (let len = 3; len <= 14; len++) {
    const word = "w".repeat(len);
    const h = L.createEmptyWordHistory(word, 4, len);
    h.attempts = 10;
    const errorRate = Math.min(1, 0.05 + len * 0.05); // scales cleanly with length
    h.incorrect = Math.round(errorRate * 10);
    h.correct = 10 - h.incorrect;
    historyStore[word] = h;
  }
  const baseline = L.computeDifficultyBaseline(historyStore);
  assert.ok(baseline.predict("w".repeat(14), 4) > baseline.predict("w".repeat(4), 4));
});

test("computeDifficultyBaseline predicts a higher error rate for a curriculum level this user actually struggles with more", () => {
  const historyStore = {};
  // 3 easy-level words always right, 3 hard-level words always wrong -
  // enough samples per group for the shrinkage factor to trust the gap,
  // but too few total points (6 < minSamplesForLengthTrend) to also fit a
  // length trend, isolating the level effect being tested here.
  for (let i = 0; i < 3; i++) {
    const easyWord = "ez" + i;
    const h = L.createEmptyWordHistory(easyWord, 4, easyWord.length);
    h.attempts = 1; h.correct = 1; h.incorrect = 0;
    historyStore[easyWord] = h;
  }
  for (let i = 0; i < 3; i++) {
    const hardWord = "hd" + i;
    const h = L.createEmptyWordHistory(hardWord, 6, hardWord.length);
    h.attempts = 1; h.correct = 0; h.incorrect = 1;
    historyStore[hardWord] = h;
  }
  const baseline = L.computeDifficultyBaseline(historyStore);
  assert.ok(baseline.predict("newword", 6) > baseline.predict("newword", 4));
});

test("computeDifficultyBaseline shrinks a level's deviation toward the average when that level has barely any data, unlike a well-sampled level with the same observed gap", () => {
  const historyStore = {};
  // Level 6: only 1 sample, 100% wrong. Level 5: 20 samples, 100% wrong.
  // Both observe the identical (extreme) local error rate, but the
  // single-sample level should barely move away from the overall average
  // while the well-sampled one moves close to its full observed rate.
  // Every entry is forced to the same length (6) so there's no length
  // trend to fit either (identical x values make the regression
  // denominator 0), isolating the level effect being tested here.
  const sparse = L.createEmptyWordHistory("sparse", 6, 6);
  sparse.attempts = 1; sparse.correct = 0; sparse.incorrect = 1;
  historyStore.sparse = sparse;
  for (let i = 0; i < 20; i++) {
    const w = "rich" + i;
    const h = L.createEmptyWordHistory(w, 5, 6);
    h.attempts = 1; h.correct = 0; h.incorrect = 1;
    historyStore[w] = h;
  }
  // A few correct words too, so the overall average isn't just 1.0 (which
  // would make every deviation collapse to 0 regardless of shrinkage).
  for (let i = 0; i < 5; i++) {
    const w = "ok" + i;
    const h = L.createEmptyWordHistory(w, 4, 6);
    h.attempts = 1; h.correct = 1; h.incorrect = 0;
    historyStore[w] = h;
  }
  const baseline = L.computeDifficultyBaseline(historyStore);
  const overallAvg = 21 / 26; // 1 sparse wrong + 20 rich wrong + 5 ok right, all out of 26
  const sparseGap = Math.abs(baseline.predict("xxxxxx", 6) - overallAvg);
  const richGap = Math.abs(baseline.predict("xxxxxx", 5) - overallAvg);
  assert.ok(sparseGap < richGap, `a 1-sample level should sit closer to the average than a 20-sample level with the same observed rate (sparseGap=${sparseGap}, richGap=${richGap})`);
});

test("computeDifficultyBaseline predicts a higher error rate for words with a doubled letter once there's enough data in both groups", () => {
  const historyStore = {};
  // Every entry forced to the same length (8) so there's no length trend
  // to fit (identical x values make the regression denominator 0),
  // isolating the doubled-letter effect being tested here. "accurate"
  // deliberately excluded from the single-letter group - it contains "cc"
  // and would otherwise get bucketed as doubled by the code regardless of
  // which list it's typed into here.
  const doubled = ["occurred", "necessary", "possess", "recommend"];
  const single = ["absolute", "abstract", "academic", "adequate"];
  for (const w of doubled) {
    const h = L.createEmptyWordHistory(w, 4, 8);
    h.attempts = 1; h.correct = 0; h.incorrect = 1;
    historyStore[w] = h;
  }
  for (const w of single) {
    const h = L.createEmptyWordHistory(w, 4, 8);
    h.attempts = 1; h.correct = 1; h.incorrect = 0;
    historyStore[w] = h;
  }
  const baseline = L.computeDifficultyBaseline(historyStore);
  assert.ok(baseline.predict("committee", 4) > baseline.predict("elephant", 4));
});

test("computeInterferenceModel is null below the minimum struggling-word count", () => {
  const historyStore = {};
  for (const w of ["light", "might"]) { // only 2, below minStruggleWordsForInterference (3)
    const h = L.createEmptyWordHistory(w, 4, w.length);
    h.attempts = 1; h.incorrect = 1; h.lastResult = "incorrect";
    historyStore[w] = h;
  }
  assert.equal(L.computeInterferenceModel(historyStore), null);
});

test("computeInterferenceModel scores a word orthographically similar to the user's struggling words higher than a dissimilar one", () => {
  const historyStore = {};
  for (const w of ["light", "might", "right"]) {
    const h = L.createEmptyWordHistory(w, 4, w.length);
    h.attempts = 1; h.incorrect = 1; h.lastResult = "incorrect";
    historyStore[w] = h;
  }
  const model = L.computeInterferenceModel(historyStore);
  assert.ok(model);
  assert.ok(model.risk("fight") > model.risk("orange"), "\"fight\" shares -ight with every struggling word; \"orange\" shares nothing");
});

test("predictWordDifficulty falls back to the baseline alone when there's no history or interference model yet", () => {
  const baseline = { predict: () => 0.3 };
  assert.equal(L.predictWordDifficulty("anything", 4, null, baseline, null), 0.3);
});

test("predictWordDifficulty blends the baseline and interference signal using CONFIG's own weights", () => {
  const baseline = { predict: () => 0.2 };
  const interferenceModel = { risk: () => 1 };
  const risk = L.predictWordDifficulty("word", 4, null, baseline, interferenceModel);
  const expected = 0.2 * L.CONFIG.difficultyBaselineWeight + 1 * L.CONFIG.difficultyInterferenceWeight;
  assert.ok(Math.abs(risk - expected) < 1e-9);
});

test("predictWordDifficulty leans toward a word's OWN empirical error rate as real attempts accumulate on it, rather than the generic baseline alone", () => {
  const baseline = { predict: () => 0.1 }; // generic prediction: low risk
  // This exact word, though, has actually been gotten wrong every time.
  const risk1 = L.predictWordDifficulty("word", 4, { attempts: 1, incorrect: 1 }, baseline, null);
  const risk20 = L.predictWordDifficulty("word", 4, { attempts: 20, incorrect: 20 }, baseline, null);
  assert.ok(risk20 > risk1, "20 confirmed wrong attempts should move the estimate further than just 1");
  assert.ok(risk20 > baseline.predict(), "with plenty of its own (bad) data, the word's own record should dominate the generic 0.1 baseline");
});

test("the unified priority pipeline (buildPriorityModels + computeSelectionWeight) falls back to an effectively uniform shuffle (still a full, non-duplicated permutation) with no data at all", () => {
  const pool = makePool(10, 4, "w");
  const models = L.buildPriorityModels({});
  const weights = pool.map((w) => L.computeSelectionWeight(w, null, models, Date.now()));
  const ranked = L.weightedShuffle(pool, weights, seededRandom(1));
  assert.equal(ranked.length, 10);
  assert.equal(new Set(ranked.map((w) => w.word)).size, 10);
});

test("the unified priority pipeline surfaces a never-attempted word similar to the user's struggling words first far more often than a dissimilar one, but not every single time", () => {
  const historyStore = {};
  // Struggling (interference-eligible) but error-rate-neutral, so this
  // scenario isolates the interference signal from the baseline one.
  for (const w of ["light", "might", "right"]) {
    const h = L.createEmptyWordHistory(w, 4, w.length);
    h.attempts = 1; h.incorrect = 0; h.correct = 1; h.lastResult = "incorrect";
    historyStore[w] = h;
  }
  const hardWord = makeWord("fight", 4); // shares "-ight" with every struggling word
  const easyWord = makeWord("orange", 4); // shares nothing
  const pool = [hardWord, easyWord];
  const models = L.buildPriorityModels(historyStore);
  const now = Date.now();
  const weights = pool.map((w) => L.computeSelectionWeight(w, null, models, now));

  // One generator reused across all trials (not reseeded per trial): a
  // freshly-seeded LCG's consecutive draws are correlated for small
  // sequential seeds, which would otherwise skew a test this sensitive.
  const rnd = seededRandom(42);
  let hardFirstCount = 0;
  const trials = 300;
  for (let i = 0; i < trials; i++) {
    const ranked = L.weightedShuffle(pool, weights, rnd);
    if (ranked[0].word === "fight") hardFirstCount += 1;
  }
  const rate = hardFirstCount / trials;
  assert.ok(rate > 0.6, `predicted-harder word should lead the majority of the time (rate=${rate})`);
  assert.ok(rate < 1, "should not be rigidly deterministic every single trial");
});

test("the unified priority pipeline surfaces an ALREADY-ATTEMPTED word the user keeps getting wrong first far more often than one they usually get right, but not every single time", () => {
  const historyStore = {};
  const oftenWrong = L.createEmptyWordHistory("stubborn", 5, 8);
  oftenWrong.attempts = 8; oftenWrong.incorrect = 7; oftenWrong.correct = 1; oftenWrong.lastResult = "incorrect";
  historyStore.stubborn = oftenWrong;
  const usuallyRight = L.createEmptyWordHistory("simple", 4, 6);
  usuallyRight.attempts = 8; usuallyRight.incorrect = 1; usuallyRight.correct = 7; usuallyRight.lastResult = "learning";
  historyStore.simple = usuallyRight;

  const pool = [makeWord("stubborn", 5), makeWord("simple", 4)];
  const models = L.buildPriorityModels(historyStore);
  const now = Date.now();
  const weights = pool.map((w) => L.computeSelectionWeight(w, historyStore[w.word], models, now));

  const rnd = seededRandom(7);
  let wrongFirstCount = 0;
  const trials = 300;
  for (let i = 0; i < trials; i++) {
    const ranked = L.weightedShuffle(pool, weights, rnd);
    if (ranked[0].word === "stubborn") wrongFirstCount += 1;
  }
  const rate = wrongFirstCount / trials;
  assert.ok(rate > 0.6, `the word this user actually keeps missing should lead the majority of the time (rate=${rate})`);
  assert.ok(rate < 1, "should not be rigidly deterministic every single trial");
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
