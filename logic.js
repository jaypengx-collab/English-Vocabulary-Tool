"use strict";

// Pure, DOM-free logic for the Vocabulary Test app: per-word historical
// data, memorization scoring, question-selection ratios, and progress
// aggregation. Nothing in this file touches localStorage, the DOM, or
// speech synthesis, so it can be unit-tested directly under Node and
// reused unchanged by both the regular Vocabulary Test and the Review
// Test (see app.js).
//
// Loaded as a plain <script> in the browser (attaches everything to
// `window.VocabLogic`) and via `require("./logic.js")` under Node tests
// (CommonJS export) - no bundler needed either way.
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  }
  if (root) {
    root.VocabLogic = mod;
  }
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function () {

  /* ---------- Centralized, tunable configuration ---------- */

  const CONFIG = {
    // How many recent attempts we keep per word for trend/consistency
    // analysis. Aggregate counters (attempts/correct/incorrect) are never
    // capped - only this detailed ring buffer is, to keep storage bounded
    // across thousands of words.
    maxRecentAttempts: 12,

    // Attempts needed before "enough observations" confidence reaches 1.0.
    // Kept low deliberately: only ~20% of each test round revisits
    // previously-seen words (see testRatio below), so any single word gets
    // re-tested infrequently - requiring many repeats before confidence
    // builds would leave most words stuck looking "unmemorized" for a long
    // time regardless of how well they're actually known.
    minObservationsForFullConfidence: 4,

    // Need at least this many timed correct answers before timing
    // contributes to the score at all (cold start relies on correctness).
    minCorrectTimedForTimingSignal: 2,
    // Timing's influence ramps up to its max as timed samples approach this.
    timingWeightFullAt: 4,
    // Timing can never account for more than this fraction of the blended
    // pre-confidence score - correctness always dominates.
    maxTimingInfluence: 0.35,

    // Smoothing factor for the per-word running-average response time.
    emaAlpha: 0.25,

    thresholds: {
      review: 0.45,
      memorized: 0.75,
    },

    // A word cannot reach "memorized" on score alone - it must also clear
    // this cold-start guard, so one lucky fast/correct answer can't do it.
    memorizedGuard: {
      minAttempts: 3,
      minCorrectStreak: 2,
      maxRecentErrorRate: 0.2,
    },

    // Regular Vocabulary Test defaults / ratio target (80% new, 10% missed,
    // 10% retention-check). Ratios are scaled proportionally to whatever
    // size is requested, so smaller legacy session sizes use the same mix.
    defaultTestSize: 80,
    testRatio: { new: 0.8, incorrect: 0.1, correct: 0.1 },

    // How strongly a weaker/less-memorized word's review-selection weight
    // grows relative to a stronger one (see reviewPriorityWeight). Higher
    // = weak words dominate the weighted draw even more.
    reviewWeaknessFloor: 0.05,
    // A word tested very recently is down-weighted for a little while so
    // review slots don't just cycle the same one or two words every round;
    // its weight recovers back to normal over this many days.
    reviewRecencyFullRecoveryDays: 3,

    // Window (most-recent attempts, across all words) used for "recent
    // performance" / response-time-trend reporting in Progress.
    recentPerformanceWindow: 30,
  };

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  /* ---------- Small numeric helpers ---------- */

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function average(arr) {
    if (!arr.length) return 0;
    let sum = 0;
    for (const v of arr) sum += v;
    return sum / arr.length;
  }

  function stddev(arr, mean) {
    if (arr.length < 2) return 0;
    const m = typeof mean === "number" ? mean : average(arr);
    let sq = 0;
    for (const v of arr) sq += (v - m) * (v - m);
    return Math.sqrt(sq / arr.length);
  }

  function shuffle(arr, random) {
    const rnd = random || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Weighted random ordering (Efraimidis-Spirakis A-ExpJ scheme): each item
  // gets a random key = u^(1/weight) for u in (0,1); sorting keys
  // descending yields a full permutation where higher-weight items tend to
  // land earlier, but never deterministically - a weak word doesn't always
  // win the same slot every round, a stronger one occasionally still gets
  // picked, and which specific word "wins" shifts as weights change after
  // each attempt. This is what makes review selection a probabilistic
  // ranking rather than a rigid "always exactly the top N" cutoff.
  function weightedShuffle(items, weights, random) {
    const rnd = random || Math.random;
    return items
      .map((item, i) => {
        const w = Math.max(1e-6, weights[i]);
        const u = Math.min(1 - 1e-12, Math.max(1e-12, rnd()));
        return { item: item, key: Math.pow(u, 1 / w) };
      })
      .sort((a, b) => b.key - a.key)
      .map((x) => x.item);
  }

  // How urgently a previously-seen word deserves a review slot: much
  // higher for weaker/less-memorized words, and temporarily suppressed
  // right after it was just tested so the same one or two words don't
  // monopolize every round while their weakness score hasn't caught up
  // yet. Purely a *weight* for weightedShuffle, not a hard cutoff.
  function reviewPriorityWeight(scoreInfo, lastSeen, now) {
    const weakness = clamp(1.05 - scoreInfo.score, CONFIG.reviewWeaknessFloor, 1.05);
    const daysSince = lastSeen ? Math.max(0, (now - lastSeen) / ONE_DAY_MS) : Infinity;
    const recencyFactor = clamp(daysSince / CONFIG.reviewRecencyFullRecoveryDays, 0.15, 1);
    return weakness * recencyFactor;
  }

  /* ---------- Per-word historical data ---------- */

  function createEmptyWordHistory(word, level, length) {
    return {
      word: word,
      level: level != null ? level : null,
      length: length != null ? length : (word ? word.length : 0),
      attempts: 0,
      correct: 0,
      incorrect: 0,
      correctStreak: 0,
      avgCorrectResponseMs: null,
      recentResponseMs: null,
      recentAttempts: [], // capped ring buffer: {correct, responseMs, timestamp, attemptNumber}
      firstSeen: 0,
      lastSeen: 0,
      lastResult: undefined,
      inWrongList: false,
      // Legacy Leitner fields, kept only so old code paths / exports that
      // might still read them don't break. Not used by the scoring below.
      box: 0,
      due: 0,
    };
  }

  // Upgrades one stored entry (any shape - brand new, legacy v1
  // `{box,due,correct,wrong,lastSeen}`, or already-current) to the current
  // shape, filling in any missing fields with safe defaults. Idempotent:
  // running it again on an already-current entry is a no-op merge, which
  // is also what makes this forward-compatible with future added fields.
  function migrateWordEntry(raw, word, level, length) {
    const base = createEmptyWordHistory(word, level, length);
    if (!raw) return base;

    if (typeof raw.attempts === "number") {
      // Already current shape (or close enough) - fill gaps only.
      return Object.assign({}, base, raw);
    }

    // Legacy v1 shape from the old Leitner-box dictation/review modes.
    const correct = raw.correct || 0;
    const wrong = raw.wrong || 0;
    const attempts = correct + wrong;
    return Object.assign({}, base, {
      attempts: attempts,
      correct: correct,
      incorrect: wrong,
      // True streak history wasn't tracked before; a conservative estimate
      // (0 unless the word has never failed) avoids overstating mastery.
      correctStreak: wrong === 0 ? correct : 0,
      lastResult: attempts === 0 ? undefined : (raw.box === 0 && wrong > 0 ? "incorrect" : "correct"),
      lastSeen: raw.lastSeen || 0,
      firstSeen: raw.lastSeen || 0,
      inWrongList: !!(wrong > 0 && raw.box === 0),
      box: typeof raw.box === "number" ? raw.box : 0,
      due: raw.due || 0,
    });
  }

  // Migrates an entire stored progress map ({ word -> entry }) in one pass.
  // `vocabIndex` (optional, word.toLowerCase() -> {word, level}) lets a
  // migrated entry recover the canonical word/level even if the stored key
  // was already lowercased.
  function migrateProgressStore(rawStore, vocabIndex) {
    const migrated = {};
    const src = rawStore || {};
    for (const key of Object.keys(src)) {
      const info = vocabIndex ? vocabIndex[key] : null;
      migrated[key] = migrateWordEntry(
        src[key],
        info ? info.word : (src[key] && src[key].word) || key,
        info ? info.level : (src[key] && src[key].level),
        info ? info.word.length : (src[key] && src[key].length) || key.length
      );
    }
    return migrated;
  }

  function computeCorrectStreak(recentAttempts) {
    let streak = 0;
    for (let i = recentAttempts.length - 1; i >= 0; i--) {
      if (recentAttempts[i].correct) streak += 1;
      else break;
    }
    return streak;
  }

  function recentErrorRateOf(recentAttempts) {
    if (!recentAttempts.length) return 0;
    const wrong = recentAttempts.filter((a) => !a.correct).length;
    return wrong / recentAttempts.length;
  }

  // Positive = later timings are faster than earlier ones (improving).
  // Needs at least 4 samples to say anything; too few points is noise, not
  // a trend, so it reports neutral (0) instead of overreacting.
  function computeImprovementTrend(chronologicalTimes) {
    if (chronologicalTimes.length < 4) return 0;
    const mid = Math.floor(chronologicalTimes.length / 2);
    const firstAvg = average(chronologicalTimes.slice(0, mid));
    const secondAvg = average(chronologicalTimes.slice(mid));
    if (firstAvg <= 0) return 0;
    return clamp((firstAvg - secondAvg) / firstAvg, -1, 1);
  }

  // Records one answer into a word's history, in place, and returns it.
  // Used by BOTH the regular Vocabulary Test and the Review Test, so the
  // two modes share one memorization system rather than drifting apart.
  function recordAttempt(history, opts) {
    const correct = !!opts.correct;
    const responseMs = typeof opts.responseMs === "number" ? opts.responseMs : null;
    const timestamp = typeof opts.timestamp === "number" ? opts.timestamp : Date.now();

    history.attempts = (history.attempts || 0) + 1;
    const attemptNumber = history.attempts;

    if (correct) {
      history.correct = (history.correct || 0) + 1;
      history.correctStreak = (history.correctStreak || 0) + 1;
    } else {
      history.incorrect = (history.incorrect || 0) + 1;
      history.correctStreak = 0;
      history.inWrongList = true;
    }
    history.lastResult = correct ? "correct" : "incorrect";
    history.lastSeen = timestamp;
    if (!history.firstSeen) history.firstSeen = timestamp;
    if (opts.level != null) history.level = opts.level;
    if (opts.length != null) history.length = opts.length;
    history.recentResponseMs = responseMs;

    if (correct && responseMs != null) {
      history.avgCorrectResponseMs =
        history.avgCorrectResponseMs == null
          ? responseMs
          : history.avgCorrectResponseMs * (1 - CONFIG.emaAlpha) + responseMs * CONFIG.emaAlpha;
    }

    const entry = { correct: correct, responseMs: responseMs, timestamp: timestamp, attemptNumber: attemptNumber };
    const list = (history.recentAttempts || []).concat(entry);
    history.recentAttempts = list.length > CONFIG.maxRecentAttempts
      ? list.slice(list.length - CONFIG.maxRecentAttempts)
      : list;

    return history;
  }

  /* ---------- Memorization scoring ---------- */

  // The core measurement asked for: "how well has this particular word
  // been memorized", not "how quickly was it typed". Response time is only
  // ever compared against THIS word's own historical baseline
  // (avgCorrectResponseMs, built purely from this word's own past correct
  // answers) - never against a fixed ms-per-character rule and never
  // against other words - so a naturally slower-to-type long word is not
  // penalized for being long; it is only penalized for being slow relative
  // to how *it* has typically gone before.
  function calculateMemorizationScore(history) {
    const h = history || {};
    const attempts = h.attempts || 0;

    if (attempts === 0) {
      return { score: 0, state: "new", accuracy: 0, confidence: 0, timingScore: null, timingWeight: 0, streak: 0, recentErrorRate: 0 };
    }

    const correct = h.correct || 0;
    // Laplace smoothing: 1/1 isn't treated as a perfect 100%, 0/1 isn't 0%.
    const accuracy = (correct + 1) / (attempts + 2);
    const confidence = clamp(attempts / CONFIG.minObservationsForFullConfidence, 0, 1);

    const recent = h.recentAttempts || [];
    const streak = computeCorrectStreak(recent);
    const recentErrorRate = recentErrorRateOf(recent);

    const timedCorrect = recent
      .filter((a) => a.correct && typeof a.responseMs === "number")
      .map((a) => a.responseMs);

    let timingScore = null;
    let timingWeight = 0;
    if (timedCorrect.length >= CONFIG.minCorrectTimedForTimingSignal) {
      const mean = average(timedCorrect);
      const sd = stddev(timedCorrect, mean);
      const cv = mean > 0 ? sd / mean : 0;
      const consistency = clamp(1 - cv, 0, 1);

      const recentTime = timedCorrect[timedCorrect.length - 1];
      const baseline = h.avgCorrectResponseMs || mean;
      const speedRatio = baseline > 0 ? recentTime / baseline : 1;
      // At/under its own baseline scores well; slower than its own usual
      // pace scores lower, tapering off smoothly rather than a hard cutoff.
      const speedScore = clamp(1.3 - speedRatio * 0.5, 0, 1);

      const improvement = computeImprovementTrend(timedCorrect);
      const improvementScore = clamp(0.5 + improvement * 0.5, 0, 1);

      timingScore = consistency * 0.4 + speedScore * 0.35 + improvementScore * 0.25;
      timingWeight = clamp(timedCorrect.length / CONFIG.timingWeightFullAt, 0, 1);
    }

    const timingInfluence = CONFIG.maxTimingInfluence * timingWeight;
    const rawBlend = timingScore == null
      ? accuracy
      : accuracy * (1 - timingInfluence) + timingScore * timingInfluence;

    // Confidence caps the score so sparse history can never look fully
    // memorized - this is the cold-start guard at the score level.
    const score = rawBlend * confidence;

    const guard = CONFIG.memorizedGuard;
    const passesMemorizedGuard =
      attempts >= guard.minAttempts &&
      streak >= guard.minCorrectStreak &&
      recentErrorRate <= guard.maxRecentErrorRate;

    let state;
    if (score >= CONFIG.thresholds.memorized && passesMemorizedGuard) state = "memorized";
    else if (score >= CONFIG.thresholds.review) state = "review";
    else state = "learning";

    return { score: score, state: state, accuracy: accuracy, confidence: confidence, timingScore: timingScore, timingWeight: timingWeight, streak: streak, recentErrorRate: recentErrorRate };
  }

  function classifyState(history) {
    return calculateMemorizationScore(history).state;
  }

  /* ---------- Regular Vocabulary Test: 80/10/10 question selection ---------- */

  function historyFor(historyStore, word) {
    return (historyStore || {})[word.toLowerCase()] || null;
  }

  function categorizeWords(pool, historyStore) {
    const unseen = [];
    const prevIncorrect = [];
    const prevCorrect = [];
    for (const w of pool) {
      const h = historyFor(historyStore, w.word);
      if (!h || !h.attempts) {
        unseen.push(w);
      } else if (h.lastResult === "incorrect") {
        prevIncorrect.push(w);
      } else {
        prevCorrect.push(w);
      }
    }
    return { unseen: unseen, prevIncorrect: prevIncorrect, prevCorrect: prevCorrect };
  }

  // Target counts for each category, scaled proportionally to `size` so
  // smaller/legacy session sizes keep the same 80/10/10 shape.
  function computeTestTargets(size) {
    const ratio = CONFIG.testRatio;
    const newTarget = Math.round(size * ratio.new);
    const incorrectTarget = Math.round(size * ratio.incorrect);
    const correctTarget = Math.max(0, size - newTarget - incorrectTarget);
    return { new: newTarget, incorrect: incorrectTarget, correct: correctTarget };
  }

  // Orders candidates for a bucket. "new" words have no history to rank
  // by, so a plain shuffle is enough. "incorrect"/"correct" (retention
  // check) words are ordered by a WEIGHTED random draw rather than a
  // deterministic sort: a weak/stale word is far more likely to land in
  // the taken-first slots, but it's not guaranteed the exact same word
  // every round - as its own score improves (or another word's does), the
  // odds shift and a different word is likely to surface next time.
  function rankCandidates(words, historyStore, random, category, now) {
    if (category === "new") return shuffle(words, random);

    const withMeta = words.map((w) => {
      const h = historyFor(historyStore, w.word) || {};
      const scoreInfo = calculateMemorizationScore(h);
      return { w: w, weight: reviewPriorityWeight(scoreInfo, h.lastSeen || 0, now) };
    });
    return weightedShuffle(withMeta.map((x) => x.w), withMeta.map((x) => x.weight), random);
  }

  // Builds the regular Vocabulary Test question list: 80% new/unseen, 10%
  // previously-incorrect, 10% previously-correct (retention check) by
  // default, redistributing missing slots intelligently when a category
  // runs short, never duplicating a word, and giving weaker/staler words a
  // much higher (but not guaranteed) chance of filling the review slots.
  function selectTestQuestions(opts) {
    const o = opts || {};
    const pool = o.pool || [];
    const historyStore = o.historyStore || {};
    const random = o.random || Math.random;
    const now = typeof o.now === "number" ? o.now : Date.now();
    const totalAvailable = pool.length;
    let size = typeof o.size === "number" && o.size > 0 ? o.size : CONFIG.defaultTestSize;
    size = Math.min(size, totalAvailable);
    if (size <= 0) return [];

    const { unseen, prevIncorrect, prevCorrect } = categorizeWords(pool, historyStore);
    const targets = computeTestTargets(size);

    const buckets = [
      { key: "new", ranked: rankCandidates(unseen, historyStore, random, "new", now), target: targets.new },
      { key: "incorrect", ranked: rankCandidates(prevIncorrect, historyStore, random, "incorrect", now), target: targets.incorrect },
      { key: "correct", ranked: rankCandidates(prevCorrect, historyStore, random, "correct", now), target: targets.correct },
    ];

    const taken = {};
    for (const b of buckets) taken[b.key] = b.ranked.slice(0, b.target);

    let selectedCount = taken.new.length + taken.incorrect.length + taken.correct.length;
    let deficit = size - selectedCount;

    // Redistribute unmet targets to whichever categories still have unused
    // words, preferring "new" first (keeps the test moving the learner
    // forward), then "incorrect", then "correct".
    const order = ["new", "incorrect", "correct"];
    let safety = 0;
    while (deficit > 0 && safety < size + 10) {
      safety += 1;
      let progressed = false;
      for (const key of order) {
        if (deficit <= 0) break;
        const bucket = buckets.find((b) => b.key === key);
        const already = taken[key].length;
        if (bucket.ranked.length > already) {
          taken[key].push(bucket.ranked[already]);
          deficit -= 1;
          progressed = true;
        }
      }
      if (!progressed) break;
    }

    const combined = taken.new.concat(taken.incorrect, taken.correct);

    // Defensive de-dupe: the three categories are disjoint by construction,
    // but guard against duplicates anyway so this invariant can never break
    // silently if the categorization logic ever changes.
    const seen = new Set();
    const deduped = [];
    for (const w of combined) {
      const key = w.word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(w);
    }

    return shuffle(deduped, random);
  }

  /* ---------- Review Test (wrong-word list) ---------- */

  function computeWrongList(pool, historyStore) {
    return pool.filter((w) => {
      const h = historyFor(historyStore, w.word);
      return !!(h && h.inWrongList);
    });
  }

  function buildReviewTestList(opts) {
    const o = opts || {};
    const pool = o.pool || [];
    const historyStore = o.historyStore || {};
    const random = o.random || Math.random;
    const wrongWords = computeWrongList(pool, historyStore);
    const shuffled = shuffle(wrongWords, random);
    return typeof o.size === "number" && o.size > 0 ? shuffled.slice(0, o.size) : shuffled;
  }

  // After a Review Test, either leave the wrong-word list untouched
  // ("keepAll") or drop only the words answered correctly in that round
  // ("removeCorrect"). `records` is [{ word, correct }, ...] for the round.
  function applyReviewOutcome(historyStore, records, mode) {
    if (mode !== "removeCorrect") return;
    for (const rec of records || []) {
      if (!rec.correct) continue;
      const h = historyFor(historyStore, rec.word);
      if (h) h.inWrongList = false;
    }
  }

  /* ---------- Progress aggregation ---------- */

  function computeProgressSummary(pool, historyStore) {
    const counts = { new: 0, learning: 0, review: 0, memorized: 0 };
    const byLevel = {};
    let totalEncountered = 0;
    let totalAttempts = 0;
    let totalCorrect = 0;
    const allRecentAttempts = [];

    for (const w of pool) {
      const h = historyFor(historyStore, w.word);
      const info = calculateMemorizationScore(h || {});
      counts[info.state] += 1;

      const lvl = w.level;
      if (!byLevel[lvl]) byLevel[lvl] = { total: 0, new: 0, learning: 0, review: 0, memorized: 0 };
      byLevel[lvl].total += 1;
      byLevel[lvl][info.state] += 1;

      if (h && h.attempts) {
        totalEncountered += 1;
        totalAttempts += h.attempts;
        totalCorrect += h.correct || 0;
        for (const a of h.recentAttempts || []) allRecentAttempts.push(a);
      }
    }

    allRecentAttempts.sort((a, b) => a.timestamp - b.timestamp);
    const recentWindow = allRecentAttempts.slice(-CONFIG.recentPerformanceWindow);
    let recentAccuracy = null;
    let responseTimeTrend = 0;
    if (recentWindow.length) {
      recentAccuracy = recentWindow.filter((a) => a.correct).length / recentWindow.length;
      const timed = recentWindow.filter((a) => a.correct && typeof a.responseMs === "number").map((a) => a.responseMs);
      responseTimeTrend = computeImprovementTrend(timed);
    }

    return {
      totalWords: pool.length,
      totalEncountered: totalEncountered,
      counts: counts,
      overallAccuracy: totalAttempts ? totalCorrect / totalAttempts : null,
      memorizationRate: pool.length ? counts.memorized / pool.length : 0,
      recentAccuracy: recentAccuracy,
      responseTimeTrend: responseTimeTrend,
      byLevel: byLevel,
    };
  }

  function computeWordDetail(w, historyStore) {
    const h = historyFor(historyStore, w.word);
    const info = calculateMemorizationScore(h || {});
    return {
      word: w.word,
      level: w.level,
      pos: w.pos,
      zh: w.zh,
      attempts: h ? h.attempts : 0,
      correct: h ? h.correct : 0,
      incorrect: h ? h.incorrect : 0,
      avgCorrectResponseMs: h ? h.avgCorrectResponseMs : null,
      recentResponseMs: h ? h.recentResponseMs : null,
      state: info.state,
      score: info.score,
      // Score sub-components, exposed so the UI can show WHY a score is
      // what it is instead of just the opaque final number - accuracy
      // (correctness so far), confidence (how much history backs that up -
      // this is what keeps a 1-2-attempt word capped low regardless of
      // speed), and timingScore (this word's own consistency/speed/
      // improvement signal, null until there's enough timed data).
      accuracy: info.accuracy,
      confidence: info.confidence,
      timingScore: info.timingScore,
      inWrongList: h ? !!h.inWrongList : false,
    };
  }

  return {
    CONFIG: CONFIG,
    clamp: clamp,
    average: average,
    stddev: stddev,
    shuffle: shuffle,
    weightedShuffle: weightedShuffle,
    reviewPriorityWeight: reviewPriorityWeight,
    createEmptyWordHistory: createEmptyWordHistory,
    migrateWordEntry: migrateWordEntry,
    migrateProgressStore: migrateProgressStore,
    computeCorrectStreak: computeCorrectStreak,
    recentErrorRateOf: recentErrorRateOf,
    computeImprovementTrend: computeImprovementTrend,
    recordAttempt: recordAttempt,
    calculateMemorizationScore: calculateMemorizationScore,
    classifyState: classifyState,
    categorizeWords: categorizeWords,
    computeTestTargets: computeTestTargets,
    selectTestQuestions: selectTestQuestions,
    computeWrongList: computeWrongList,
    buildReviewTestList: buildReviewTestList,
    applyReviewOutcome: applyReviewOutcome,
    computeProgressSummary: computeProgressSummary,
    computeWordDetail: computeWordDetail,
  };
});
