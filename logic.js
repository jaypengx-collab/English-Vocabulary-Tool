"use strict";

// Pure, DOM-free logic for the Vocabulary Test app: per-word historical
// data, state classification, question-selection ratios, and progress
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
    // How many recent attempts we keep per word for wrong-answer history
    // and response-time trend analysis. Aggregate counters (attempts/
    // correct/incorrect) are never capped - only this detailed ring
    // buffer is, to keep storage bounded across thousands of words.
    maxRecentAttempts: 12,

    // A word is Memorized the moment its current correct streak reaches
    // this many in a row; any single wrong answer resets the streak to 0
    // (and the word immediately reads as "incorrect" again). Deliberately
    // simple and purely correctness-driven - no score, no confidence
    // ramp, no timing gate on the label itself.
    memorizedStreak: 2,

    // Smoothing factor for the per-word running-average correct response
    // time (avgCorrectResponseMs). Used only for review-priority ranking
    // below, never for the Memorized label.
    emaAlpha: 0.25,

    // Default question-type mix for a round: mostly new words, with small
    // slices revisiting currently-wrong and currently-learning words.
    // Scaled proportionally to whatever size is requested. Memorized words
    // are deliberately excluded from selection entirely - they've already
    // graduated, so slots go to words that still need work. The user can
    // override this ratio via the home screen's three percentage sliders
    // (see selectQuestions's own `ratio` option) - this is only the
    // starting point shown there, not a fixed mode.
    defaultQuestionSize: 80,
    defaultQuestionRatio: { new: 0.8, incorrect: 0.1, learning: 0.1 },

    // Review-selection priority weighting, by response time: a word's own
    // average correct-response time is compared against the EXPECTED time
    // for a word of ITS OWN length (see computeResponseTimeBaseline) -
    // slower-than-expected-for-its-length words get a higher chance of
    // filling a review slot, faster-than-expected ones a lower chance.
    // Deliberately NOT compared against one flat overall average across
    // every word regardless of length - a flat average is dominated by
    // whatever length is most common, so a genuinely long word (more
    // characters to type, nothing to do with how well it's memorized)
    // would always read as "slow" and a short one always "fast", no matter
    // how well either is actually known. This only affects how often a
    // word gets picked for practice, never whether it counts as Memorized
    // (that's streak-only, see above), so it never mislabels a word just
    // for naturally taking longer to type.
    timeWeightMin: 0.3,
    timeWeightMax: 3,
    // Below this many (length, avgCorrectResponseMs) data points across the
    // whole store, there isn't enough signal to trust a fitted length trend
    // (see computeResponseTimeBaseline) - fall back to one flat expected
    // time (the plain overall average) for every length instead of
    // overfitting a line to a handful of points.
    minSamplesForLengthTrend: 8,
    // A word tested moments ago is temporarily de-prioritized (even if
    // it's slow/weak) so the same word or two don't monopolize every
    // round; its weight recovers back to normal over this many days.
    reviewRecencyFullRecoveryDays: 3,

    // Window (most-recent attempts, across all words) used for "recent
    // performance" / response-time-trend reporting in Progress.
    recentPerformanceWindow: 30,

    // How many distinct past wrong answers to surface per word in
    // Progress (most recent first), so a word's mistake pattern (e.g.
    // consistently swapping two letters) is visible before a review.
    maxRecentWrongAnswersShown: 3,

    // ---- Auto-balance mode (see computeAutoBalanceRatio) ----
    // The review "backlog" (incorrect + learning word count) at which auto
    // mode treats review pressure as maxed out - a backlog at or above this
    // gets the ceiling review share below; a backlog of 0 always gets 0%
    // review (nothing to review yet, so it's 100% new words) regardless of
    // this number.
    autoBalanceBacklogSaturation: 40,
    // Review share never exceeds this even at a saturated backlog - some
    // new words always keep trickling in rather than the round ever going
    // 100% review, so the backlog itself keeps shrinking relative to total
    // vocabulary instead of just holding steady.
    autoBalanceMaxReviewShare: 0.75,
    // Review share floor the moment there IS any backlog at all (jumps
    // straight from 0% at zero backlog to at least this much) - a single
    // incorrect word still deserves noticeable practice time, not a
    // rounding-error sliver of a huge round.
    autoBalanceMinReviewShare: 0.15,
    // Within the review share, incorrect words are weighted this many times
    // more urgently than learning words per-word (still-wrong beats
    // almost-there) when splitting the share between the two categories.
    autoBalanceIncorrectWeight: 1.5,

    // ---- Predicting word difficulty - one system for new, incorrect, and
    // learning words alike (see predictWordDifficulty/rankCandidates) ----
    // Shrinkage constant for the level/doubled-letter group effects in
    // computeDifficultyBaseline (empirical-Bayes style): a group's observed
    // deviation from the overall average error rate is scaled by
    // n/(n+K) before being trusted, so a group seen only once or twice
    // contributes almost nothing (avoiding the earlier per-letter model's
    // mistake of treating a handful of data points as a real pattern),
    // while a group with lots of data counts nearly at face value.
    difficultyShrinkageK: 6,
    // Minimum attempted words containing a doubled letter (or lacking one)
    // before that group's error-rate deviation is used at all - below this,
    // even a shrunk deviation is still too noisy to bother computing.
    minSamplesForDoubledLetterEffect: 4,
    // Minimum words currently in "incorrect" state before
    // computeInterferenceModel bothers comparing candidate words against
    // them - similarity to a single struggling word is a coincidence, not a
    // pattern, until there are a few to compare against.
    minStruggleWordsForInterference: 3,
    // Shrinkage constant for blending a word's OWN empirical error rate
    // (once it's actually been attempted) with the objective baseline (see
    // predictWordDifficulty) - attempts/(attempts+K) is how much its own
    // track record is trusted over the baseline prediction. Deliberately
    // much smaller than difficultyShrinkageK above: a handful of attempts
    // on THIS specific word is far more informative about it than a
    // handful of samples in a 2-3-way group bucket is about that group, so
    // it should earn trust faster.
    difficultyOwnDataShrinkageK: 3,
    // How much of a word's predicted difficulty comes from the objective
    // baseline (length + curriculum level + orthographic irregularity -
    // see computeDifficultyBaseline - blended with the word's own
    // empirical error rate once it has one) vs. how similar it looks to
    // words this learner is already struggling with (see
    // computeInterferenceModel), once there's enough data for the latter
    // at all (see predictWordDifficulty).
    difficultyBaselineWeight: 0.6,
    difficultyInterferenceWeight: 0.4,
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

  // Ordinary least-squares fit of y = intercept + slope*x over `points`
  // ({x, y}[]) - used to model "expected response time as a function of
  // word length" (see computeResponseTimeBaseline). Returns null when
  // there's no meaningful slope to fit (fewer than 2 points, or every
  // point shares the same x - e.g. every attempted word so far happens to
  // be the same length), letting the caller fall back to a flat average.
  function linearRegression(points) {
    const n = points.length;
    if (n < 2) return null;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumXX += p.x * p.x;
    }
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { slope: slope, intercept: intercept };
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
  // land earlier, but never deterministically - a slow/weak word doesn't
  // always win the same slot every round, a faster one occasionally still
  // gets picked, and which specific word "wins" shifts as weights change
  // after each attempt.
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
      lastWrongAnswer: null, // most recent incorrect answer the user typed
      recentAttempts: [], // capped ring buffer: {correct, responseMs, timestamp, attemptNumber, answer}
      firstSeen: 0,
      lastSeen: 0,
      lastResult: undefined,
      // Last time this word was engaged with in ANY way - a quiz attempt
      // (see recordAttempt below) or just being shown in 複習's flashcard
      // browsing view (see markReviewed) - never mind whether the answer
      // was right. Distinct from lastSeen (quiz attempts only, and used for
      // review-priority/state purposes) - this exists purely to drive
      // selectReviewBatch, so a large backlog surfaces neglected words
      // first instead of the same front-of-the-list words every session.
      lastReviewedAt: 0,
      // 0 = not marked; otherwise when the user explicitly flagged this
      // word "review this again" (see setMarked) - completely independent
      // of state (new/incorrect/learning/memorized) and of the automatic
      // lastReviewedAt rotation above. That rotation deliberately pushes a
      // just-viewed word to the back of the queue so a big backlog keeps
      // moving forward; marking is the escape hatch for "no, I specifically
      // want to see THIS one again soon" - a word stays marked until the
      // user unmarks it, it is never cleared automatically by browsing or
      // by answering it correctly.
      markedAt: 0,
      // Legacy fields from earlier schema versions, kept only so old
      // stored data doesn't break migration; not used by any logic below.
      box: 0,
      due: 0,
      inWrongList: false,
    };
  }

  // Upgrades one stored entry (any shape - brand new, legacy v1
  // `{box,due,correct,wrong,lastSeen}`, an intermediate score-based v2
  // shape, or already-current) to the current shape, filling in any
  // missing fields with safe defaults. Idempotent: running it again on an
  // already-current entry is a no-op merge, which is also what makes this
  // forward-compatible with future added fields.
  function migrateWordEntry(raw, word, level, length) {
    const base = createEmptyWordHistory(word, level, length);
    if (!raw) return base;

    if (typeof raw.attempts === "number") {
      // Already current-ish shape (v2 or later) - fill gaps only. Older
      // v2 entries may carry now-unused fields (e.g. inWrongList, a
      // score/confidence breakdown) - harmless to keep around unused.
      return Object.assign({}, base, raw);
    }

    // Legacy v1 shape from the original Leitner-box dictation/review modes.
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
  // two modes share one system rather than drifting apart. `opts.answer`
  // is the raw text the user typed - stored (only for wrong answers, since
  // a correct one is trivially just the word itself) so mistakes can be
  // reviewed later instead of just a bare correct/incorrect flag.
  function recordAttempt(history, opts) {
    const correct = !!opts.correct;
    const responseMs = typeof opts.responseMs === "number" ? opts.responseMs : null;
    const timestamp = typeof opts.timestamp === "number" ? opts.timestamp : Date.now();
    const answer = typeof opts.answer === "string" ? opts.answer : null;

    history.attempts = (history.attempts || 0) + 1;
    const attemptNumber = history.attempts;

    if (correct) {
      history.correct = (history.correct || 0) + 1;
      history.correctStreak = (history.correctStreak || 0) + 1;
    } else {
      history.incorrect = (history.incorrect || 0) + 1;
      history.correctStreak = 0;
      history.lastWrongAnswer = answer;
    }
    history.lastResult = correct ? "correct" : "incorrect";
    history.lastSeen = timestamp;
    history.lastReviewedAt = timestamp;
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

    const entry = {
      correct: correct,
      responseMs: responseMs,
      timestamp: timestamp,
      attemptNumber: attemptNumber,
      answer: correct ? undefined : answer,
    };
    const list = (history.recentAttempts || []).concat(entry);
    history.recentAttempts = list.length > CONFIG.maxRecentAttempts
      ? list.slice(list.length - CONFIG.maxRecentAttempts)
      : list;

    return history;
  }

  // Records the lighter-weight "just looked at this in 複習's flashcard
  // view" engagement, in place - no attempt/correctness involved (browsing
  // a card isn't being tested on it), just a timestamp so selectReviewBatch
  // can stop re-surfacing it every session. A real quiz attempt already
  // updates the same field via recordAttempt above.
  function markReviewed(history, timestamp) {
    history.lastReviewedAt = typeof timestamp === "number" ? timestamp : Date.now();
    return history;
  }

  // Toggles (or explicitly sets) a word's "review this again" flag - see
  // createEmptyWordHistory's own comment on markedAt for why this is
  // separate from lastReviewedAt/the automatic rotation. `marked` true
  // sets markedAt to `timestamp` (defaulting to now); false/omitted clears
  // it back to 0.
  function setMarked(history, marked, timestamp) {
    history.markedAt = marked ? (typeof timestamp === "number" ? timestamp : Date.now()) : 0;
    return history;
  }
  function isMarked(history) {
    return !!(history && history.markedAt > 0);
  }

  /* ---------- State classification (simple, streak-based) ---------- */

  // Four states: "new" (never attempted - not one of the three tracked
  // states, just bookkeeping for the pool that hasn't been touched yet),
  // "incorrect" (most recent answer was wrong), "learning" (correct, but
  // streak hasn't reached memorizedStreak yet), "memorized" (current
  // streak >= memorizedStreak). Any single wrong answer immediately drops
  // a word from "memorized" straight back to "incorrect".
  function classifyState(history) {
    const h = history || {};
    if (!h.attempts) return "new";
    if (h.lastResult === "incorrect") return "incorrect";
    return (h.correctStreak || 0) >= CONFIG.memorizedStreak ? "memorized" : "learning";
  }

  // Most recent distinct wrong answers for a word, newest first - lets the
  // UI show e.g. "you've typed 'wierd' and 'werid' before" rather than
  // just the single latest slip.
  function recentWrongAnswersOf(history, limit) {
    const h = history || {};
    const cap = limit || CONFIG.maxRecentWrongAnswersShown;
    const chronological = (h.recentAttempts || []).filter((a) => !a.correct && a.answer);
    const seen = new Set();
    const out = [];
    for (let i = chronological.length - 1; i >= 0 && out.length < cap; i--) {
      const ans = chronological[i].answer;
      if (seen.has(ans)) continue;
      seen.add(ans);
      out.push(ans);
    }
    return out;
  }

  // Simple LCS-based character diff between what the user typed and the
  // correct spelling, aligned against the CORRECT word: each letter of the
  // correct word is marked matched (they typed it, in order) or missed
  // (they didn't) - enough to visually spot "swapped two letters" or "left
  // one out" mistakes without a heavyweight diff library.
  function diffChars(typed, correct) {
    const a = (typed || "").split("");
    const b = (correct || "").split("");
    const n = a.length;
    const m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    let i = n;
    let j = m;
    const ops = [];
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        ops.push({ char: b[j - 1], match: true });
        i -= 1;
        j -= 1;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i -= 1;
      } else {
        ops.push({ char: b[j - 1], match: false });
        j -= 1;
      }
    }
    while (j > 0) {
      ops.push({ char: b[j - 1], match: false });
      j -= 1;
    }
    ops.reverse();
    return ops;
  }

  // Same LCS backtrack as diffChars, but returns BOTH sides of the diff:
  // the correct spelling with letters the user never typed marked missed
  // (identical to diffChars's own result), and what the user actually
  // typed with the letters that threw the spelling off - extra letters,
  // or ones swapped out of place - marked wrong. Lets the UI show "this is
  // what you typed, and THIS specific part of it was the problem" rather
  // than only ever annotating the correct answer.
  function diffCharsBoth(typed, correct) {
    const a = (typed || "").split("");
    const b = (correct || "").split("");
    const n = a.length;
    const m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    let i = n;
    let j = m;
    const typedOps = [];
    const correctOps = [];
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        typedOps.push({ char: a[i - 1], match: true });
        correctOps.push({ char: b[j - 1], match: true });
        i -= 1;
        j -= 1;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        typedOps.push({ char: a[i - 1], match: false });
        i -= 1;
      } else {
        correctOps.push({ char: b[j - 1], match: false });
        j -= 1;
      }
    }
    while (i > 0) {
      typedOps.push({ char: a[i - 1], match: false });
      i -= 1;
    }
    while (j > 0) {
      correctOps.push({ char: b[j - 1], match: false });
      j -= 1;
    }
    typedOps.reverse();
    correctOps.reverse();
    return { typed: typedOps, correct: correctOps };
  }

  /* ---------- Review-priority weighting (time-based) ---------- */

  function historyFor(historyStore, word) {
    return (historyStore || {})[word.toLowerCase()] || null;
  }

  // The user's own overall average correct-response time, across every
  // word they have timing data for - their general pace. Recomputed from
  // current data each time (not stored), so it always reflects reality.
  // Purely informational (the Progress screen's "平均反應時間" stat) -
  // NOT used for review-priority weighting, since a flat average mixes
  // together words of every length (see computeResponseTimeBaseline for
  // the length-aware figure that IS used for that).
  function computeGlobalAverageResponseMs(historyStore) {
    const store = historyStore || {};
    const times = [];
    for (const key of Object.keys(store)) {
      const h = store[key];
      if (h && typeof h.avgCorrectResponseMs === "number") times.push(h.avgCorrectResponseMs);
    }
    return times.length ? average(times) : null;
  }

  // Models "expected correct-response time as a function of word length"
  // from every word with timing data, via a simple linear fit (longer
  // words legitimately take longer to type - this bakes that in rather
  // than pretending every word "should" take the same time). Returns null
  // when there's no timing data at all yet. With too few data points to
  // trust a fitted trend (see CONFIG.minSamplesForLengthTrend), falls back
  // to one flat expected time for every length - the plain overall
  // average, same number computeGlobalAverageResponseMs reports - rather
  // than overfitting a line to a handful of points. A fitted NEGATIVE
  // slope (longer words predicted faster) is clamped to 0: that shape is
  // almost certainly noise this early, not a real effect, and left
  // uncorrected would perversely flag long words as needing LESS practice.
  function computeResponseTimeBaseline(historyStore) {
    const store = historyStore || {};
    const points = [];
    for (const key of Object.keys(store)) {
      const h = store[key];
      if (h && typeof h.avgCorrectResponseMs === "number" && typeof h.length === "number" && h.length > 0) {
        points.push({ x: h.length, y: h.avgCorrectResponseMs });
      }
    }
    if (!points.length) return null;

    const overallAvg = average(points.map((p) => p.y));
    if (points.length < CONFIG.minSamplesForLengthTrend) {
      return { predict: () => overallAvg };
    }
    const fit = linearRegression(points);
    if (!fit) return { predict: () => overallAvg };
    const slope = Math.max(0, fit.slope);
    return { predict: (length) => Math.max(1, fit.intercept + slope * (length || 0)) };
  }

  // A word's own average correct-response time relative to what's expected
  // for a word of ITS length (see computeResponseTimeBaseline) - 1.0 means
  // "right on pace for a word this long", >1 slower than expected, <1
  // faster. Returns null when there's nothing to compare (no baseline yet,
  // or this word itself has no timing data).
  function relativeResponseTime(history, baseline) {
    const h = history || {};
    if (!baseline || typeof h.avgCorrectResponseMs !== "number") return null;
    const expected = baseline.predict(h.length);
    if (!expected || expected <= 0) return null;
    return h.avgCorrectResponseMs / expected;
  }

  /* ---------- Predicting word difficulty - one system for new, incorrect,
     and learning words alike ----------
     Two independent signals grounded in how word memorization is actually
     understood to work, not a single fragile heuristic:

     1. computeDifficultyBaseline - an OBJECTIVE difficulty estimate from
        properties of the word itself: length (more letters means more
        chances to slip - a serial-recall effect, not folklore), curriculum
        level (this vocabulary list is already tiered roughly by frequency,
        and word frequency is one of the most robust predictors of recall
        accuracy in the vocabulary-acquisition literature - rarer words are
        genuinely harder to encode and retain), and whether the word
        contains a doubled letter (a well-documented spelling trouble spot
        for learners - duplicated letters get dropped or added because nothing
        in the pronunciation cues the doubling). Level/doubled-letter effects
        are shrunk toward the overall average based on sample size (see
        CONFIG.difficultyShrinkageK) so a group seen only once or twice can't
        swing the estimate - the earlier design's mistake was trusting a
        26-way split (one bucket per letter) built from a handful of
        mistakes; this only ever splits into 2-3 buckets, each with far more
        data to actually estimate from.

     2. computeInterferenceModel - a PERSONALIZED signal grounded in
        interference theory (a well-replicated finding in verbal-learning
        research: items that look alike compete with each other in memory,
        so a word orthographically similar to one you already keep getting
        wrong is disproportionately likely to trip you up too, regardless of
        which specific letters are involved). Measured as bigram-overlap
        similarity to this learner's own currently-incorrect words, not a
        single-letter miss tally - so it reflects actual shared spelling
        patterns between two words, not a coincidence of one letter
        appearing in both.

     Both are cheap, defensible proxies built entirely from data already in
     progressStore, nothing external - and both degrade gracefully (return
     null / a neutral score) rather than pretending confidence they don't
     have.

     A never-attempted ("new") word has nothing but these two signals to go
     on. An already-attempted (incorrect/learning) word has something far
     better available: its OWN observed track record on THIS specific user
     - so predictWordDifficulty (below) blends that in too, once there's
     enough of it to trust over the general baseline. This is what makes it
     one system for new/incorrect/learning alike, not three - a review word
     isn't "predicted" difficult, its difficulty is directly measured, and
     that measurement only gets more trusted as more attempts accumulate. */

  // Consecutive-letter bigrams of a word, e.g. "quiet" -> ["qu","ui","ie","et"].
  function bigramsOf(word) {
    const w = (word || "").toLowerCase();
    const grams = [];
    for (let i = 0; i < w.length - 1; i++) grams.push(w.slice(i, i + 2));
    return grams;
  }

  // Jaccard similarity (intersection over union) between two words' bigram
  // sets - a standard, simple measure of orthographic similarity (the same
  // idea behind fuzzy-matching/spelling-suggestion tools): 1 for identical
  // spelling, 0 for nothing in common, scaling smoothly in between for
  // words that share some but not all of their letter-pairs.
  function bigramSimilarity(wordA, wordB) {
    const a = new Set(bigramsOf(wordA));
    const b = new Set(bigramsOf(wordB));
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const g of a) if (b.has(g)) intersection += 1;
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  // Whether a word contains any letter immediately repeated (e.g.
  // "necessary", "occurred") - a well-documented spelling trouble spot,
  // since nothing in how the word sounds cues the doubling.
  function hasDoubledLetter(word) {
    const w = (word || "").toLowerCase();
    for (let i = 1; i < w.length; i++) {
      if (w[i] === w[i - 1] && w[i] >= "a" && w[i] <= "z") return true;
    }
    return false;
  }

  // Empirical-Bayes-style shrinkage: scales an observed group's deviation
  // from the overall average toward 0 based on how much data that group
  // actually has (n/(n+K)), so a group with just one or two samples barely
  // moves the estimate while a well-sampled group counts almost at face
  // value. Shared by both the level and doubled-letter group effects below.
  function shrunkDeviation(groupErrorRate, groupCount, overallAvg, k) {
    const trust = groupCount / (groupCount + k);
    return (groupErrorRate - overallAvg) * trust;
  }

  // Objective "expected error rate" for a word from properties anyone could
  // observe about it (not this learner's personal history beyond what
  // calibrates the model): a length trend (same regression technique as
  // computeResponseTimeBaseline), plus shrunk group effects for curriculum
  // level and doubled letters. Returns null with no attempted words at all.
  function computeDifficultyBaseline(historyStore) {
    const store = historyStore || {};
    const lengthPoints = [];
    const byLevel = {};
    const byDoubled = { yes: [], no: [] };

    for (const key of Object.keys(store)) {
      const h = store[key];
      if (!h || !h.attempts) continue;
      const errorRate = (h.incorrect || 0) / h.attempts;
      if (typeof h.length === "number" && h.length > 0) lengthPoints.push({ x: h.length, y: errorRate });
      if (h.level != null) {
        (byLevel[h.level] = byLevel[h.level] || []).push(errorRate);
      }
      if (h.word) (hasDoubledLetter(h.word) ? byDoubled.yes : byDoubled.no).push(errorRate);
    }

    if (!lengthPoints.length) return null;
    const overallAvg = clamp(average(lengthPoints.map((p) => p.y)), 0, 1);

    let lengthPredict;
    if (lengthPoints.length < CONFIG.minSamplesForLengthTrend) {
      lengthPredict = () => overallAvg;
    } else {
      const fit = linearRegression(lengthPoints);
      lengthPredict = fit ? (length) => clamp(fit.intercept + fit.slope * (length || 0), 0, 1) : () => overallAvg;
    }

    const levelDeviation = {};
    for (const level of Object.keys(byLevel)) {
      const rates = byLevel[level];
      levelDeviation[level] = shrunkDeviation(average(rates), rates.length, overallAvg, CONFIG.difficultyShrinkageK);
    }

    let doubledDeviation = 0;
    if (byDoubled.yes.length >= CONFIG.minSamplesForDoubledLetterEffect && byDoubled.no.length >= CONFIG.minSamplesForDoubledLetterEffect) {
      doubledDeviation = shrunkDeviation(average(byDoubled.yes), byDoubled.yes.length, overallAvg, CONFIG.difficultyShrinkageK);
    }

    return {
      predict: (word, level) => {
        const w = word || "";
        let risk = lengthPredict(w.length);
        if (level != null && levelDeviation[level] != null) risk += levelDeviation[level];
        if (doubledDeviation && hasDoubledLetter(w)) risk += doubledDeviation;
        return clamp(risk, 0, 1);
      },
    };
  }

  // How similar a candidate word is to the words this learner is currently
  // getting wrong (see categorizeWords's "incorrect" bucket) - the highest
  // bigram similarity to any one struggling word, since interference from a
  // single close look-alike is what actually drives confusion (not a
  // diffuse average across every struggling word, most of which won't
  // resemble the candidate at all). Returns null below
  // CONFIG.minStruggleWordsForInterference words - similarity to only one or
  // two struggling words is too easily a coincidence to act on.
  function computeInterferenceModel(historyStore) {
    const store = historyStore || {};
    const strugglingWords = [];
    for (const key of Object.keys(store)) {
      const h = store[key];
      if (h && h.word && h.lastResult === "incorrect") strugglingWords.push(h.word);
    }
    if (strugglingWords.length < CONFIG.minStruggleWordsForInterference) return null;
    return {
      risk: (word) => {
        let best = 0;
        for (const struggling of strugglingWords) {
          const sim = bigramSimilarity(word, struggling);
          if (sim > best) best = sim;
        }
        return best;
      },
    };
  }

  // One 0..1-ish predicted difficulty for a word, whether it's never been
  // attempted or has a full history: starts from the objective baseline
  // (or a neutral 0.15 with no baseline data at all yet), then - if this
  // word itself has been attempted - blends in its own empirical error
  // rate via the same empirical-Bayes shrinkage idea used inside the
  // baseline's own group effects (CONFIG.difficultyOwnDataShrinkageK): a
  // word tried once and missed shouldn't swing straight to "certain risk",
  // but as real attempts accumulate on THIS word, its own track record
  // increasingly dominates the generic prediction. That blended objective
  // risk is then combined with the interference signal, same as before
  // (see CONFIG.difficultyBaselineWeight/difficultyInterferenceWeight).
  function predictWordDifficulty(word, level, history, baseline, interferenceModel) {
    let objRisk = baseline ? baseline.predict(word, level) : 0.15;
    if (history && history.attempts) {
      const ownErrorRate = clamp((history.incorrect || 0) / history.attempts, 0, 1);
      const trust = history.attempts / (history.attempts + CONFIG.difficultyOwnDataShrinkageK);
      objRisk = ownErrorRate * trust + objRisk * (1 - trust);
    }
    if (!interferenceModel) return objRisk;
    const interferenceRisk = interferenceModel.risk(word);
    return clamp(objRisk * CONFIG.difficultyBaselineWeight + interferenceRisk * CONFIG.difficultyInterferenceWeight, 0, 1);
  }

  // Every model predictWordDifficulty/computeSelectionWeight need, built
  // once per round from historyStore and shared across new/incorrect/
  // learning alike (see rankCandidates) rather than each category
  // recomputing its own copy.
  function buildPriorityModels(historyStore) {
    return {
      difficultyBaseline: computeDifficultyBaseline(historyStore),
      interferenceModel: computeInterferenceModel(historyStore),
      responseTimeBaseline: computeResponseTimeBaseline(historyStore),
    };
  }

  // Turns a word's predicted difficulty (see predictWordDifficulty) into a
  // full weightedShuffle weight, the same for new/incorrect/learning words
  // alike: predicted risk sets the baseline pull, then two multiplicative
  // adjustments layer on top exactly as they always have for review words -
  // a slower-than-expected response time (still a meaningful signal beyond
  // raw correctness: hesitation on a technically-right answer) nudges the
  // weight up further, and a temporary dampener right after the word was
  // last tested keeps the same word or two from monopolizing every round.
  // A never-attempted word simply has no response time or last-seen data,
  // so both adjustments are no-ops for it - one formula, no per-category
  // branching required.
  function computeSelectionWeight(w, history, models, now) {
    const risk = predictWordDifficulty(w.word, w.level, history, models.difficultyBaseline, models.interferenceModel);
    let weight = 0.5 + risk * 2;

    const rel = relativeResponseTime(history, models.responseTimeBaseline);
    if (rel != null) weight *= clamp(rel, CONFIG.timeWeightMin, CONFIG.timeWeightMax);

    const lastSeen = (history && history.lastSeen) || 0;
    const daysSince = lastSeen ? Math.max(0, (now - lastSeen) / ONE_DAY_MS) : Infinity;
    weight *= clamp(daysSince / CONFIG.reviewRecencyFullRecoveryDays, 0.15, 1);

    return weight;
  }

  /* ---------- Word categorization ---------- */

  function categorizeWords(pool, historyStore) {
    const unseen = [];
    const incorrect = [];
    const learning = [];
    const memorized = [];
    for (const w of pool) {
      const h = historyFor(historyStore, w.word);
      const state = classifyState(h);
      if (state === "new") unseen.push(w);
      else if (state === "incorrect") incorrect.push(w);
      else if (state === "memorized") memorized.push(w);
      else learning.push(w);
    }
    return { unseen: unseen, incorrect: incorrect, learning: learning, memorized: memorized };
  }

  // Words the user has explicitly marked "review this again" (see
  // setMarked) - orthogonal to categorizeWords's state buckets above, so
  // this can include a word of ANY state (even Memorized - marking it
  // doesn't change its state, and answering it right enough times doesn't
  // un-mark it either; only the user unmarking it does).
  function filterMarked(pool, historyStore) {
    return pool.filter((w) => isMarked(historyFor(historyStore, w.word)));
  }

  // Picks up to `size` words from `words`, ordered so the ones LEAST
  // recently engaged with (see lastReviewedAt - either a quiz attempt or a
  // flashcard view, whichever happened last) come first, with a random
  // tiebreak among equal timestamps (overwhelmingly words never reviewed at
  // all yet, which all sit at 0). This is what makes 複習's flashcard view
  // usable with a large backlog: instead of the same few hundred words in
  // the same order every session, each session surfaces whichever words
  // have gone the longest untouched, so a big backlog naturally spreads
  // itself across as many sessions as it takes - no manual bookkeeping, and
  // (since lastReviewedAt lives on the synced history entry, not separate
  // per-device state) the same rotation continues on any device the
  // learner's progress is synced to.
  function selectReviewBatch(words, historyStore, size, random) {
    const shuffled = shuffle(words, random);
    const withTimestamp = shuffled.map((w) => ({
      w: w,
      lastReviewedAt: (historyFor(historyStore, w.word) || {}).lastReviewedAt || 0,
    }));
    withTimestamp.sort((a, b) => a.lastReviewedAt - b.lastReviewedAt);
    return withTimestamp.slice(0, Math.max(0, size)).map((x) => x.w);
  }

  // Orders a bucket's candidates by predicted difficulty (see
  // computeSelectionWeight) via a WEIGHTED random draw, never a rigid sort
  // - a predicted-easy word still has some chance of coming up early, a
  // predicted-hard one is never guaranteed the same slot every round. The
  // exact same weighting applies whether `words` is the new/incorrect/
  // learning bucket - there is no per-category branch here at all, that's
  // the point (see predictWordDifficulty's own comment). With no data
  // anywhere yet, every word gets an identical weight, which makes this a
  // plain uniform shuffle in every way that matters.
  function rankCandidates(words, historyStore, random, now, models) {
    const withMeta = words.map((w) => {
      const h = historyFor(historyStore, w.word);
      return { w: w, weight: computeSelectionWeight(w, h, models, now) };
    });
    return weightedShuffle(withMeta.map((x) => x.w), withMeta.map((x) => x.weight), random);
  }

  // Fills bucket targets from ranked candidate lists, then redistributes
  // any unmet targets (a category running short) into whichever buckets
  // still have unused candidates, trying `order` first-to-last, and
  // de-dupes defensively. Shared by both the regular test and Review Test
  // builders below since they only differ in their bucket set/ratio.
  function fillBucketsWithFallback(buckets, size, order) {
    const taken = {};
    for (const b of buckets) taken[b.key] = b.ranked.slice(0, b.target);

    let selectedCount = 0;
    for (const key of Object.keys(taken)) selectedCount += taken[key].length;
    let deficit = size - selectedCount;

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

    const combined = [];
    for (const key of order) combined.push.apply(combined, taken[key]);

    const seen = new Set();
    const deduped = [];
    for (const w of combined) {
      const key = w.word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(w);
    }
    return deduped;
  }

  /* ---------- Auto-balance mode: a ratio derived from live word counts ---------- */

  // Turns raw category counts (unseen/incorrect/learning - memorized is
  // always excluded from selection, same as every other mode) into a
  // question-mix ratio, the same shape selectQuestions's `ratio` option
  // expects. Deliberately NOT an equal three-way split ("balance the
  // number of them" does not mean 33/33/33): a brand-new learner has
  // hundreds of unseen words and near-zero review backlog, so an equal
  // split would still bury them in review words they've never even seen
  // once. Instead the review SHARE (incorrect+learning combined) scales up
  // smoothly with how large the backlog actually is - small backlog, mostly
  // new words; large backlog, mostly review - between a floor and a
  // ceiling so neither ever goes fully 0% or 100%. The incorrect/learning
  // split within that share leans toward incorrect words (still wrong beats
  // almost-there), proportioned by how many of each currently exist.
  function computeAutoBalanceRatio(counts) {
    const newCount = Math.max(0, counts.new || 0);
    const incorrectCount = Math.max(0, counts.incorrect || 0);
    const learningCount = Math.max(0, counts.learning || 0);
    const backlog = incorrectCount + learningCount;

    if (backlog === 0) return { new: 1, incorrect: 0, learning: 0 };

    const backlogPressure = clamp(backlog / CONFIG.autoBalanceBacklogSaturation, 0, 1);
    let reviewShare =
      CONFIG.autoBalanceMinReviewShare +
      backlogPressure * (CONFIG.autoBalanceMaxReviewShare - CONFIG.autoBalanceMinReviewShare);

    // No new words left to show at all (every word in the selected levels
    // has been attempted at least once) - the round can only be review.
    if (newCount === 0) reviewShare = 1;

    const newShare = 1 - reviewShare;
    const incorrectWeight = incorrectCount * CONFIG.autoBalanceIncorrectWeight;
    const learningWeight = learningCount;
    const totalWeight = incorrectWeight + learningWeight;
    const incorrectShare = totalWeight > 0 ? reviewShare * (incorrectWeight / totalWeight) : 0;
    const learningShare = totalWeight > 0 ? reviewShare * (learningWeight / totalWeight) : 0;

    return { new: newShare, incorrect: incorrectShare, learning: learningShare };
  }

  // Convenience wrapper: categorizes `pool` against `historyStore` itself,
  // so callers (the app's "auto" mode) don't need to call categorizeWords
  // separately just to get counts. Safe to call on every question/answer
  // in a round - it's just a counting pass over the pool, no randomness -
  // which is what lets auto mode re-derive its ratio live as words move
  // between categories mid-round.
  function computeAutoBalanceRatioForPool(pool, historyStore) {
    const cats = categorizeWords(pool, historyStore);
    return computeAutoBalanceRatio({
      new: cats.unseen.length,
      incorrect: cats.incorrect.length,
      learning: cats.learning.length,
    });
  }

  /* ---------- Question selection: ratio-driven, one mode ---------- */

  // Target counts for each of the three selectable categories, scaled from
  // `ratio` (need not sum to exactly 1 - normalized here) proportionally to
  // `size`. The LAST category (learning) absorbs whatever rounding leaves
  // over, so the three targets always sum to exactly `size` - not just
  // approximately, the way three independently-rounded numbers could drift
  // by one.
  function computeQuestionTargets(size, ratio) {
    const r = ratio || CONFIG.defaultQuestionRatio;
    const raw = { new: Math.max(0, r.new || 0), incorrect: Math.max(0, r.incorrect || 0), learning: Math.max(0, r.learning || 0) };
    const total = raw.new + raw.incorrect + raw.learning || 1;
    const newTarget = Math.round((size * raw.new) / total);
    const incorrectTarget = Math.round((size * raw.incorrect) / total);
    const learningTarget = Math.max(0, size - newTarget - incorrectTarget);
    return { new: newTarget, incorrect: incorrectTarget, learning: learningTarget };
  }

  // Builds one round's question list, mixing new/unseen, currently-incorrect,
  // and currently-learning words according to `opts.ratio` (each 0..1, need
  // not sum to exactly 1; defaults to CONFIG.defaultQuestionRatio, the old
  // 80/10/10 "mostly new words" shape) - this is the one selection function
  // for the app's one practice mode: what used to be two fixed modes
  // (Vocabulary Test's 80/10/10, Review Test's 70/30-with-no-new-words) are
  // now just two points on the same ratio the user can set anywhere via the
  // home screen's sliders (0% on a category simply excludes it, including
  // from the fallback redistribution below - a slider set to 0 means never
  // show that category, not "only as a last resort"). Redistributes a
  // shortfall in one category into the other non-zero categories (in ratio
  // order) rather than ever duplicating a word; memorized words are always
  // excluded - they've graduated.
  function selectQuestions(opts) {
    const o = opts || {};
    const pool = o.pool || [];
    const historyStore = o.historyStore || {};
    const random = o.random || Math.random;
    const now = typeof o.now === "number" ? o.now : Date.now();
    const ratio = o.ratio || CONFIG.defaultQuestionRatio;
    const totalAvailable = pool.length;
    let size = typeof o.size === "number" && o.size > 0 ? o.size : CONFIG.defaultQuestionSize;
    size = Math.min(size, totalAvailable);
    if (size <= 0) return [];

    const { unseen, incorrect, learning } = categorizeWords(pool, historyStore);
    const models = buildPriorityModels(historyStore);
    const targets = computeQuestionTargets(size, ratio);
    const categoryWords = { new: unseen, incorrect: incorrect, learning: learning };

    const order = ["new", "incorrect", "learning"].filter((key) => (ratio[key] || 0) > 0);
    if (!order.length) return [];

    const buckets = order.map((key) => ({
      key: key,
      ranked: rankCandidates(categoryWords[key], historyStore, random, now, models),
      target: targets[key],
    }));

    const deduped = fillBucketsWithFallback(buckets, size, order);
    return shuffle(deduped, random);
  }

  /* ---------- Progress aggregation ---------- */

  function computeProgressSummary(pool, historyStore) {
    const counts = { new: 0, incorrect: 0, learning: 0, memorized: 0 };
    const byLevel = {};
    let totalEncountered = 0;
    let totalAttempts = 0;
    let totalCorrect = 0;
    const allRecentAttempts = [];

    for (const w of pool) {
      const h = historyFor(historyStore, w.word);
      const state = classifyState(h);
      counts[state] += 1;

      const lvl = w.level;
      if (!byLevel[lvl]) byLevel[lvl] = { total: 0, new: 0, incorrect: 0, learning: 0, memorized: 0 };
      byLevel[lvl].total += 1;
      byLevel[lvl][state] += 1;

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
      globalAverageResponseMs: computeGlobalAverageResponseMs(historyStore),
      byLevel: byLevel,
    };
  }

  // `baseline` (see computeResponseTimeBaseline) is optional - pass it when
  // the caller needs relativeResponseTime (e.g. sorting the 複習 lists by
  // "which words are slow FOR THEIR LENGTH"); omit it and that field is
  // just null, same as before this existed. Callers rendering many words
  // at once should compute the baseline ONCE up front and pass the same
  // one into every call here, rather than recomputing it per word.
  function computeWordDetail(w, historyStore, baseline) {
    const h = historyFor(historyStore, w.word);
    const state = classifyState(h);
    return {
      word: w.word,
      level: w.level,
      pos: w.pos,
      zh: w.zh,
      attempts: h ? h.attempts : 0,
      correct: h ? h.correct : 0,
      incorrect: h ? h.incorrect : 0,
      correctStreak: h ? h.correctStreak : 0,
      avgCorrectResponseMs: h ? h.avgCorrectResponseMs : null,
      recentResponseMs: h ? h.recentResponseMs : null,
      lastWrongAnswer: h ? h.lastWrongAnswer : null,
      recentWrongAnswers: recentWrongAnswersOf(h),
      state: state,
      relativeResponseTime: baseline ? relativeResponseTime(h, baseline) : null,
      marked: isMarked(h),
      markedAt: h ? h.markedAt || 0 : 0,
    };
  }

  return {
    CONFIG: CONFIG,
    clamp: clamp,
    average: average,
    stddev: stddev,
    shuffle: shuffle,
    weightedShuffle: weightedShuffle,
    createEmptyWordHistory: createEmptyWordHistory,
    migrateWordEntry: migrateWordEntry,
    migrateProgressStore: migrateProgressStore,
    computeImprovementTrend: computeImprovementTrend,
    recordAttempt: recordAttempt,
    markReviewed: markReviewed,
    setMarked: setMarked,
    isMarked: isMarked,
    classifyState: classifyState,
    recentWrongAnswersOf: recentWrongAnswersOf,
    diffChars: diffChars,
    diffCharsBoth: diffCharsBoth,
    computeGlobalAverageResponseMs: computeGlobalAverageResponseMs,
    computeResponseTimeBaseline: computeResponseTimeBaseline,
    relativeResponseTime: relativeResponseTime,
    bigramsOf: bigramsOf,
    bigramSimilarity: bigramSimilarity,
    hasDoubledLetter: hasDoubledLetter,
    computeDifficultyBaseline: computeDifficultyBaseline,
    computeInterferenceModel: computeInterferenceModel,
    predictWordDifficulty: predictWordDifficulty,
    buildPriorityModels: buildPriorityModels,
    computeSelectionWeight: computeSelectionWeight,
    categorizeWords: categorizeWords,
    filterMarked: filterMarked,
    selectReviewBatch: selectReviewBatch,
    computeQuestionTargets: computeQuestionTargets,
    computeAutoBalanceRatio: computeAutoBalanceRatio,
    computeAutoBalanceRatioForPool: computeAutoBalanceRatioForPool,
    selectQuestions: selectQuestions,
    computeProgressSummary: computeProgressSummary,
    computeWordDetail: computeWordDetail,
  };
});
