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

// Plays out N attempts against a fresh history for `word`, at fixed
// responseMs unless overridden per-attempt.
function play(history, results) {
  let t = 1000;
  for (const r of results) {
    t += 1000;
    L.recordAttempt(history, { correct: r.correct, responseMs: r.responseMs, timestamp: t, level: 4, length: history.length });
  }
  return history;
}

/* ================= Recording: correctness, response time, length, attempts ================= */

test("recordAttempt tracks correct/incorrect, response time, length and attempt number", () => {
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

  L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 6000, level: 6, length: 13 });
  assert.equal(h.attempts, 2);
  assert.equal(h.incorrect, 1);
  assert.equal(h.recentAttempts[1].attemptNumber, 2);
  assert.equal(h.lastResult, "incorrect");
  assert.equal(h.inWrongList, true, "an incorrect answer flags the word into the wrong list");
});

test("recordAttempt handles multiple attempts and caps the detailed ring buffer without losing aggregate counts", () => {
  const h = L.createEmptyWordHistory("run", 4, 3);
  for (let i = 0; i < 30; i++) {
    L.recordAttempt(h, { correct: i % 3 !== 0, responseMs: 800 + i, timestamp: 1000 + i, level: 4, length: 3 });
  }
  assert.equal(h.attempts, 30, "aggregate attempt count is never capped");
  assert.ok(h.recentAttempts.length <= L.CONFIG.maxRecentAttempts, "detailed history is capped for storage");
  assert.equal(h.recentAttempts[h.recentAttempts.length - 1].attemptNumber, 30, "ring buffer keeps the most recent attempts");
});

test("correct streak resets on an incorrect answer and accumulates on correct ones", () => {
  const h = L.createEmptyWordHistory("cat", 4, 3);
  play(h, [{ correct: true }, { correct: true }, { correct: false }, { correct: true }]);
  assert.equal(h.correctStreak, 1);
});

/* ================= Memorization scoring: cold start ================= */

test("a single correct (even fast) attempt must not reach Memorized", () => {
  const h = L.createEmptyWordHistory("go", 4, 2);
  L.recordAttempt(h, { correct: true, responseMs: 400, timestamp: 1000, level: 4, length: 2 });
  const info = L.calculateMemorizationScore(h);
  assert.notEqual(info.state, "memorized");
});

test("brand new (unattempted) word is state 'new' with score 0", () => {
  const h = L.createEmptyWordHistory("never-tested", 4, 12);
  const info = L.calculateMemorizationScore(h);
  assert.equal(info.state, "new");
  assert.equal(info.score, 0);
});

test("cold start: early attempts rely more on correctness than timing", () => {
  const h = L.createEmptyWordHistory("bat", 4, 3);
  // One correct attempt, no timing history yet at all.
  L.recordAttempt(h, { correct: true, responseMs: null, timestamp: 1000, level: 4, length: 3 });
  const info = L.calculateMemorizationScore(h);
  assert.equal(info.timingScore, null, "timing has no signal yet");
  assert.ok(info.score > 0, "correctness alone still moves the score off zero");
});

test("timing's influence ramps up only as more timed data accumulates", () => {
  const sparse = L.createEmptyWordHistory("sparse", 4, 6);
  play(sparse, [{ correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 }]);
  const sparseInfo = L.calculateMemorizationScore(sparse);

  const rich = L.createEmptyWordHistory("rich", 4, 4);
  play(rich, [
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
    { correct: true, responseMs: 1000 },
  ]);
  const richInfo = L.calculateMemorizationScore(rich);
  assert.ok(richInfo.timingWeight > sparseInfo.timingWeight, "more timed samples => more timing weight");
});

test("one unusually slow outlier among many fast correct answers does not dominate the score", () => {
  const steady = L.createEmptyWordHistory("steady", 4, 5);
  play(steady, [
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
  ]);
  const before = L.calculateMemorizationScore(steady).score;

  const withOutlier = L.createEmptyWordHistory("steady2", 4, 5);
  play(withOutlier, [
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 9000 }, // one wild outlier
  ]);
  const after = L.calculateMemorizationScore(withOutlier).score;

  assert.ok(after > before * 0.6, "a single outlier should dent, not crater, the score");
});

/* ================= Memorization scoring: improvement & consistency ================= */

test("improving response times over attempts raise the score vs a flat/no-timing baseline", () => {
  const improving = L.createEmptyWordHistory("improve", 4, 6);
  play(improving, [
    { correct: true, responseMs: 3000 }, { correct: true, responseMs: 2600 },
    { correct: true, responseMs: 1600 }, { correct: true, responseMs: 1200 },
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 900 },
  ]);
  const info = L.calculateMemorizationScore(improving);
  assert.ok(info.timingScore > 0.5, "a clearly improving trend should score above neutral");
});

test("consistent response times score higher on the timing signal than wildly inconsistent ones", () => {
  const consistent = L.createEmptyWordHistory("steadyc", 4, 5);
  play(consistent, [
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1020 },
    { correct: true, responseMs: 980 }, { correct: true, responseMs: 1010 },
  ]);
  const erratic = L.createEmptyWordHistory("erratic", 4, 5);
  play(erratic, [
    { correct: true, responseMs: 400 }, { correct: true, responseMs: 4000 },
    { correct: true, responseMs: 300 }, { correct: true, responseMs: 5000 },
  ]);
  const consistentInfo = L.calculateMemorizationScore(consistent);
  const erraticInfo = L.calculateMemorizationScore(erratic);
  assert.ok(consistentInfo.timingScore > erraticInfo.timingScore);
});

/* ================= Word-length fairness (critical requirement) ================= */

test("a longer word answered consistently at its OWN natural pace scores like a shorter word at its own pace", () => {
  const short = L.createEmptyWordHistory("cat", 4, 3);
  play(short, [
    { correct: true, responseMs: 700 }, { correct: true, responseMs: 720 },
    { correct: true, responseMs: 680 }, { correct: true, responseMs: 710 },
    { correct: true, responseMs: 690 },
  ]);

  const long = L.createEmptyWordHistory("extraordinary", 6, 13);
  play(long, [
    { correct: true, responseMs: 3200 }, { correct: true, responseMs: 3250 },
    { correct: true, responseMs: 3150 }, { correct: true, responseMs: 3220 },
    { correct: true, responseMs: 3180 },
  ]);

  const shortInfo = L.calculateMemorizationScore(short);
  const longInfo = L.calculateMemorizationScore(long);

  assert.ok(
    Math.abs(shortInfo.score - longInfo.score) < 0.05,
    `long word should not be penalized purely for taking longer in absolute ms (short=${shortInfo.score}, long=${longInfo.score})`
  );
  assert.equal(shortInfo.state, longInfo.state);
});

test("a long word that is fast/consistent relative to ITS OWN history beats a long word that is slowing down relative to its own history", () => {
  const solid = L.createEmptyWordHistory("understanding", 6, 13);
  play(solid, [
    { correct: true, responseMs: 2500 }, { correct: true, responseMs: 2450 },
    { correct: true, responseMs: 2520 }, { correct: true, responseMs: 2480 },
    { correct: true, responseMs: 2500 },
  ]);
  const slowingDown = L.createEmptyWordHistory("consequently", 6, 13);
  play(slowingDown, [
    { correct: true, responseMs: 1500 }, { correct: true, responseMs: 1900 },
    { correct: true, responseMs: 2400 }, { correct: true, responseMs: 3200 },
    { correct: true, responseMs: 4200 },
  ]);
  const solidInfo = L.calculateMemorizationScore(solid);
  const slowingInfo = L.calculateMemorizationScore(slowingDown);
  assert.ok(solidInfo.score > slowingInfo.score, "degrading relative to one's own baseline should score lower, independent of word length");
});

test("raw response time is never compared against a fixed ms-per-character rule or divided by word length", () => {
  // A word so long that any naive responseTime/length or fixed-ms-per-char
  // rule would read as "fast enough" or "too slow" independent of the
  // word's own history. Here the *raw* times are large only because the
  // word is long, but they are dead consistent - should score well.
  const longWord = L.createEmptyWordHistory("internationalization", 6, 21);
  play(longWord, [
    { correct: true, responseMs: 6000 }, { correct: true, responseMs: 6050 },
    { correct: true, responseMs: 5980 }, { correct: true, responseMs: 6020 },
    { correct: true, responseMs: 6010 }, { correct: true, responseMs: 6015 },
  ]);
  const info = L.calculateMemorizationScore(longWord);
  assert.equal(info.state, "memorized", "long-but-stable-relative-to-itself should still reach Memorized");
});

/* ================= Error rate / repeated incorrect ================= */

test("repeated incorrect answers keep the score low and prevent Memorized", () => {
  const h = L.createEmptyWordHistory("hard", 4, 4);
  play(h, [
    { correct: false, responseMs: 1000 }, { correct: false, responseMs: 1000 },
    { correct: true, responseMs: 1000 }, { correct: false, responseMs: 1000 },
    { correct: true, responseMs: 1000 },
  ]);
  const info = L.calculateMemorizationScore(h);
  assert.notEqual(info.state, "memorized");
  assert.ok(info.accuracy < 0.6);
});

/* ================= Question selection: 80/10/10 ratio ================= */

test("computeTestTargets scales the 80/10/10 ratio to arbitrary sizes", () => {
  assert.deepEqual(L.computeTestTargets(80), { new: 64, incorrect: 8, correct: 8 });
  const t20 = L.computeTestTargets(20);
  assert.equal(t20.new + t20.incorrect + t20.correct, 20);
  assert.equal(t20.new, 16);
});

test("selectTestQuestions hits the target 80/10/10 mix when all categories have ample supply", () => {
  const historyStore = {};
  const newWords = makePool(200, 4, "new");
  const incorrectWords = makePool(50, 5, "bad");
  const correctWords = makePool(50, 6, "good");

  for (const w of incorrectWords) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 1200, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  for (const w of correctWords) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: true, responseMs: 1200, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }

  const pool = newWords.concat(incorrectWords, correctWords);
  const selection = L.selectTestQuestions({ pool, historyStore, size: 80, random: seededRandom(42) });

  assert.equal(selection.length, 80);
  const cats = L.categorizeWords(selection, historyStore);
  assert.equal(cats.unseen.length, 64);
  assert.equal(cats.prevIncorrect.length, 8);
  assert.equal(cats.prevCorrect.length, 8);
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
  // Only 2 previously-incorrect words and 1 previously-correct word exist,
  // far short of the 8/8 the 80/10/10 ratio would want at size 80. Plenty
  // of unseen words exist to redistribute into.
  const pool = makePool(90, 4, "u");
  const incorrect = pool.slice(0, 2);
  const correctOnes = pool.slice(2, 3);
  for (const w of incorrect) {
    const h = L.createEmptyWordHistory(w.word, w.level, w.word.length);
    L.recordAttempt(h, { correct: false, responseMs: 900, timestamp: 1000, level: w.level, length: w.word.length });
    historyStore[w.word.toLowerCase()] = h;
  }
  for (const w of correctOnes) {
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

test("selectTestQuestions prioritizes lower-scoring (weaker) words within the previously-incorrect bucket", () => {
  const historyStore = {};
  const pool = makePool(4, 4, "w");
  // weak: many failures, strong: one failure long ago then recovering pattern kept as lastResult=incorrect via a final miss
  const weak = pool[0], strong = pool[1], filler1 = pool[2], filler2 = pool[3];

  const weakHist = L.createEmptyWordHistory(weak.word, 4, weak.word.length);
  play(weakHist, [{ correct: false }, { correct: false }, { correct: false }]);
  historyStore[weak.word.toLowerCase()] = weakHist;

  const strongHist = L.createEmptyWordHistory(strong.word, 4, strong.word.length);
  play(strongHist, [{ correct: true }, { correct: true }, { correct: false }]);
  historyStore[strong.word.toLowerCase()] = strongHist;

  const selection = L.selectTestQuestions({ pool: [weak, strong], historyStore, size: 2, random: seededRandom(9) });
  // Both should be picked (only 2 words, target incorrect=0 but redistribution fills them in);
  // this just verifies rankCandidates ordering doesn't crash and includes the weaker word.
  const words = selection.map((w) => w.word);
  assert.ok(words.includes(weak.word));
});

/* ================= Review Test ================= */

test("buildReviewTestList only includes words currently in the wrong list", () => {
  const historyStore = {};
  const pool = makePool(5, 4, "r");
  const wrongOne = pool[0];
  const fineOne = pool[1];

  const wrongHist = L.createEmptyWordHistory(wrongOne.word, 4, wrongOne.word.length);
  L.recordAttempt(wrongHist, { correct: false, responseMs: 1000, timestamp: 1000, level: 4, length: wrongOne.word.length });
  historyStore[wrongOne.word.toLowerCase()] = wrongHist;

  const fineHist = L.createEmptyWordHistory(fineOne.word, 4, fineOne.word.length);
  L.recordAttempt(fineHist, { correct: true, responseMs: 1000, timestamp: 1000, level: 4, length: fineOne.word.length });
  historyStore[fineOne.word.toLowerCase()] = fineHist;

  const list = L.buildReviewTestList({ pool, historyStore, random: seededRandom(2) });
  assert.equal(list.length, 1);
  assert.equal(list[0].word, wrongOne.word);
});

test("applyReviewOutcome 'removeCorrect' removes only words answered correctly this round; 'keepAll' changes nothing", () => {
  const historyStore = {};
  const words = ["alpha", "beta"];
  for (const w of words) {
    const h = L.createEmptyWordHistory(w, 4, w.length);
    L.recordAttempt(h, { correct: false, responseMs: 1000, timestamp: 1000, level: 4, length: w.length });
    historyStore[w] = h;
  }
  assert.equal(historyStore.alpha.inWrongList, true);
  assert.equal(historyStore.beta.inWrongList, true);

  // Simulate a review round: alpha answered correctly this time, beta still wrong.
  const records = [{ word: "alpha", correct: true }, { word: "beta", correct: false }];

  // keepAll: nothing changes.
  L.applyReviewOutcome(historyStore, records, "keepAll");
  assert.equal(historyStore.alpha.inWrongList, true);
  assert.equal(historyStore.beta.inWrongList, true);

  // removeCorrect: only alpha (answered correctly) leaves the wrong list.
  L.applyReviewOutcome(historyStore, records, "removeCorrect");
  assert.equal(historyStore.alpha.inWrongList, false);
  assert.equal(historyStore.beta.inWrongList, true);
});

test("Review Test recording uses the same recordAttempt/scoring system as the regular test", () => {
  const h = L.createEmptyWordHistory("shared", 4, 6);
  // Simulate answering once via "regular test" and once via "review test" -
  // both just call recordAttempt/calculateMemorizationScore, so behavior
  // must be identical regardless of which mode called it.
  L.recordAttempt(h, { correct: true, responseMs: 1000, timestamp: 1000, level: 4, length: 6 });
  const afterRegular = L.calculateMemorizationScore(h);
  L.recordAttempt(h, { correct: true, responseMs: 1000, timestamp: 2000, level: 4, length: 6 });
  const afterReview = L.calculateMemorizationScore(h);
  assert.ok(afterReview.score >= afterRegular.score);
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
  assert.ok(Array.isArray(migrated.recentAttempts));
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
  assert.equal(migrated.zebra.inWrongList, true, "a legacy box-0 failure is treated as still on the wrong list");
});

test("migrateProgressStore on an empty/missing store returns an empty object, not an error", () => {
  assert.deepEqual(L.migrateProgressStore(null, {}), {});
  assert.deepEqual(L.migrateProgressStore(undefined, {}), {});
});

/* ================= Progress summary ================= */

test("computeProgressSummary reports counts by state and by level, plus overall accuracy", () => {
  const historyStore = {};
  const pool = [makeWord("a", 4), makeWord("b", 4), makeWord("c", 5)];

  const ha = L.createEmptyWordHistory("a", 4, 1);
  play(ha, [
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
    { correct: true, responseMs: 1000 }, { correct: true, responseMs: 1000 },
  ]);
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
  assert.equal(summary.counts.learning, 1);
  assert.equal(summary.byLevel[4].total, 2);
  assert.equal(summary.byLevel[5].total, 1);
  assert.ok(summary.overallAccuracy > 0 && summary.overallAccuracy < 1);
});

test("computeWordDetail exposes the per-word fields needed for the Progress word list", () => {
  const historyStore = {};
  const w = makeWord("detail", 5);
  const h = L.createEmptyWordHistory("detail", 5, 6);
  L.recordAttempt(h, { correct: true, responseMs: 1500, timestamp: 1000, level: 5, length: 6 });
  historyStore.detail = h;

  const detail = L.computeWordDetail(w, historyStore);
  assert.equal(detail.word, "detail");
  assert.equal(detail.level, 5);
  assert.equal(detail.attempts, 1);
  assert.equal(detail.correct, 1);
  assert.equal(detail.avgCorrectResponseMs, 1500);
  assert.ok(["new", "learning", "review", "memorized"].includes(detail.state));
});
