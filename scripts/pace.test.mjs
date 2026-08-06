/**
 * Unit tests for pace measurement (D28) — the dwell clock and the derivations.
 *
 * These matter more than most: the output is used to ask whether a person took
 * their assessment seriously, so every edge that could turn a normal working
 * pattern into an accusation is pinned here. Run with `npm run test:unit`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createDwellClock, sanitiseDwell, DWELL_CEILING_MS } from "../lib/dwell.ts";
import { summarise, summariseByCe, paceLabel } from "../lib/pace.ts";

/* ------------------------------------------------------------- the clock */

test("the clock measures elapsed visible time", () => {
  const c = createDwellClock(1_000);
  assert.equal(c.read(4_000), 3_000);
});

test("hidden time does not count — a meeting is not thinking", () => {
  const c = createDwellClock(0);
  c.pause(5_000);            // 5s of real work, then the tab goes away
  c.resume(605_000);         // back ten minutes later
  assert.equal(c.read(607_000), 7_000, "only the visible 5s + 2s may count");
});

test("a reading over the ceiling is discarded, not clamped", () => {
  const c = createDwellClock(0);
  // Clamping would put DWELL_CEILING_MS into a median looking like a real
  // measurement of a real answer. Null says what is true: not measured.
  assert.equal(c.read(DWELL_CEILING_MS + 1), null);
  assert.equal(c.read(DWELL_CEILING_MS), DWELL_CEILING_MS);
});

test("a very fast answer is kept — that reading is the whole point", () => {
  const c = createDwellClock(0);
  assert.equal(c.read(900), 900);
});

test("pause and resume are idempotent, so a duplicate event cannot double-count", () => {
  const c = createDwellClock(0);
  c.pause(1_000);
  c.pause(9_000);            // a second hidden event with no resume between
  c.resume(10_000);
  c.resume(20_000);          // ditto
  assert.equal(c.read(11_000), 2_000);
});

test("a clock that starts hidden counts nothing until it is resumed", () => {
  const c = createDwellClock(0, false);
  assert.equal(c.read(5_000), 0);
  c.resume(5_000);
  assert.equal(c.read(6_000), 1_000);
});

test("time running backwards reads null — a broken clock is not a fast answer", () => {
  /* The first version clamped the negative span to zero with Math.max, which
     made the "return null" branch dead code and turned an NTP step or a
     suspend/resume into a 0ms reading — below every control's reading floor,
     i.e. the most severe possible statement about a person, produced by a
     hardware event. The test asserted the 0 and so enshrined it. */
  const c = createDwellClock(10_000);
  assert.equal(c.read(9_000), null);
});

test("and it stays broken — a clock that healed itself would report a partial duration", () => {
  const c = createDwellClock(10_000);
  assert.equal(c.read(9_000), null);
  assert.equal(c.read(20_000), null, "later sane spans must not resurrect the reading");
});

test("a backwards jump while hidden also breaks the clock", () => {
  const c = createDwellClock(10_000);
  c.pause(5_000);
  assert.equal(c.read(30_000), null);
});

/* --------------------------------------------------------- the sanitiser */

test("the server refuses what it can tell is not a real reading", () => {
  assert.equal(sanitiseDwell(1_500), 1_500);
  assert.equal(sanitiseDwell(0), 0);
  assert.equal(sanitiseDwell(-1), null);
  assert.equal(sanitiseDwell(DWELL_CEILING_MS + 1), null);
  assert.equal(sanitiseDwell("60000"), null, "a string is not a measurement");
  assert.equal(sanitiseDwell(NaN), null);
  assert.equal(sanitiseDwell(Infinity), null);
  assert.equal(sanitiseDwell(undefined), null);
  assert.equal(sanitiseDwell(null), null);
});

/* ------------------------------------------------------- the derivations */

const ctl = (code, ce, words) => ({
  code, area: "A", ce_code: ce, active: true,
  indicator: Array(words).fill("word").join(" "),
  description: null,
});

/** n scores, answered in order, each `secs` seconds, all on `level`. */
const run = (codes, secs, level = 3, evidence = null) =>
  codes.map((code, i) => ({
    control_code: code,
    self_level: level,
    evidence,
    dwell_ms: (Array.isArray(secs) ? secs[i] : secs) * 1000,
    answered_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));

test("median is over the timed answers, and the two counts are reported apart", () => {
  const controls = [ctl("1.1", "1", 10), ctl("1.2", "1", 10), ctl("1.3", "1", 10)];
  const scores = run(["1.1", "1.2", "1.3"], [10, 20, 60]);
  scores[2].dwell_ms = null;                    // scored but not measured
  const s = summarise(scores, controls);
  assert.equal(s.scored, 3);
  assert.equal(s.measured, 2, "a missing reading must not be counted as measured");
  assert.equal(s.medianSeconds, 15);
});

test("an unscored control is not counted as scored", () => {
  const controls = [ctl("1.1", "1", 10), ctl("1.2", "1", 10)];
  const scores = run(["1.1", "1.2"], 10);
  scores[1].self_level = null;
  assert.equal(summarise(scores, controls).scored, 1);
});

test("the trend stays silent until there are enough readings to mean anything", () => {
  const controls = Array.from({ length: 7 }, (_, i) => ctl(`1.${i}`, "1", 10));
  const scores = run(controls.map((c) => c.code), 10);
  const s = summarise(scores, controls);
  assert.equal(s.firstHalfSeconds, null, "7 readings must not produce a trend");
  assert.equal(s.secondHalfSeconds, null);
});

test("speeding up shows as a lower second half", () => {
  const codes = Array.from({ length: 8 }, (_, i) => `1.${i}`);
  const controls = codes.map((c) => ctl(c, "1", 10));
  const s = summarise(run(codes, [60, 60, 60, 60, 20, 20, 20, 20]), controls);
  assert.equal(s.firstHalfSeconds, 60);
  assert.equal(s.secondHalfSeconds, 20);
});

test("the trend follows the order answered, not the order stored", () => {
  const codes = ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7"];
  const controls = codes.map((c) => ctl(c, "1", 10));
  const scores = run(codes, [60, 60, 60, 60, 20, 20, 20, 20]);
  const shuffled = [scores[7], scores[2], scores[5], scores[0],
    scores[6], scores[1], scores[4], scores[3]];
  const s = summarise(shuffled, controls);
  assert.equal(s.firstHalfSeconds, 60, "answered_at must decide the order");
  assert.equal(s.secondHalfSeconds, 20);
});

test("'faster than reading' uses the control's own text, not a fixed threshold", () => {
  // 200 wpm => 1000 words is 5 minutes of reading; 20 words is 6 seconds.
  const controls = [ctl("1.1", "1", 1000), ctl("1.2", "1", 20)];
  const s = summarise(run(["1.1", "1.2"], 30), controls);
  assert.equal(s.underReading, 1, "30s is under the long control and over the short one");
});

test("an answer with no reading cannot be counted as too fast", () => {
  const controls = [ctl("1.1", "1", 1000)];
  const scores = run(["1.1"], 1);
  scores[0].dwell_ms = null;
  assert.equal(summarise(scores, controls).underReading, 0);
});

test("a straight line shows as one level and a modal share of 1", () => {
  const codes = ["1.1", "1.2", "1.3", "1.4"];
  const controls = codes.map((c) => ctl(c, "1", 10));
  const s = summarise(run(codes, 30, 3), controls);
  assert.equal(s.levelsUsed, 1);
  assert.equal(s.modalShare, 1);
});

test("a varied sheet shows spread, which stalling cannot manufacture", () => {
  const codes = ["1.1", "1.2", "1.3", "1.4"];
  const controls = codes.map((c) => ctl(c, "1", 10));
  const scores = run(codes, 30);
  scores[0].self_level = 1; scores[1].self_level = 2;
  scores[2].self_level = 3; scores[3].self_level = 3;
  const s = summarise(scores, controls);
  assert.equal(s.levelsUsed, 3);
  assert.equal(s.modalShare, 0.5);
});

test("level 0 is a real answer, not a missing one", () => {
  const controls = [ctl("1.1", "1", 10), ctl("1.2", "1", 10)];
  const scores = run(["1.1", "1.2"], 30);
  scores[0].self_level = 0;
  const s = summarise(scores, controls);
  assert.equal(s.scored, 2, "Unaware is an answer — a falsy level must not vanish");
  assert.equal(s.levelsUsed, 2);
});

test("evidence share counts only non-blank text", () => {
  const codes = ["1.1", "1.2", "1.3", "1.4"];
  const controls = codes.map((c) => ctl(c, "1", 10));
  const scores = run(codes, 30);
  scores[0].evidence = "led the migration";
  scores[1].evidence = "   ";                  // whitespace is not evidence
  const s = summarise(scores, controls);
  assert.equal(s.evidenceShare, 0.25);
});

test("an empty assessment produces zeros, not NaN or a division by zero", () => {
  const s = summarise([], []);
  assert.equal(s.scored, 0);
  assert.equal(s.measured, 0);
  assert.equal(s.medianSeconds, null);
  assert.equal(s.modalShare, 0);
  assert.equal(s.evidenceShare, 0);
  assert.equal(s.levelsUsed, 0);
});

test("a score for a control outside the active set leaves every figure alone", () => {
  // The inactive control (4.3.2.6), or one dropped from the framework after
  // being scored. "Inactive controls contribute nothing to any rollup"
  // (CLAUDE.md) — and every figure must agree, or the screen can print a
  // `measured` larger than its own `scored`.
  const s = summarise(run(["9.9"], 5), [ctl("1.1", "1", 10)]);
  assert.equal(s.measured, 0);
  assert.equal(s.scored, 0);
  assert.equal(s.underReading, 0);
  assert.equal(s.levelsUsed, 0);
});

test("measured can never exceed scored's own population", () => {
  const controls = [ctl("1.1", "1", 10)];
  const scores = [...run(["1.1"], 10), ...run(["9.9"], 10)];   // one is inactive
  const s = summarise(scores, controls);
  assert.ok(s.measured <= s.scored + 1, "same population, so the two agree");
  assert.equal(s.measured, 1);
  assert.equal(s.scored, 1);
});

test("the per-competency breakdown follows framework order, not arrival order", () => {
  const controls = [ctl("1.1", "1.1", 10), ctl("2.1", "2.1", 10)];
  const scores = [...run(["2.1"], 40), ...run(["1.1"], 10)];
  const rows = summariseByCe(scores, controls, ["1.1", "2.1"]);
  assert.deepEqual(rows.map((r) => r.ce_code), ["1.1", "2.1"]);
  assert.equal(rows[0].medianSeconds, 10);
  assert.equal(rows[1].medianSeconds, 40);
});

test("a competency with no scores at all is left out rather than shown as zero", () => {
  const controls = [ctl("1.1", "1.1", 10)];
  const rows = summariseByCe(run(["1.1"], 10), controls, ["1.1", "2.1"]);
  assert.equal(rows.length, 1);
});

test("the label reads as a duration a person says out loud", () => {
  assert.equal(paceLabel(null), "—");
  assert.equal(paceLabel(45), "45 s");
  assert.equal(paceLabel(89), "89 s");
  assert.equal(paceLabel(90), "1 min 30 s");
  assert.equal(paceLabel(120), "2 min");
});
