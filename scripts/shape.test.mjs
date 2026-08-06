/**
 * Unit tests for the two pure pieces of the flow work: duration estimates and
 * the area/competency shape. Run with `npm run test:unit`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateMinutes, estimateLabel, measureIndex } from "../lib/duration.ts";
import { shapeOf, nextAfter, scoredCodes, isComplete } from "../lib/shape.ts";
import { hasStalled, daysSince, STALL_DAYS } from "../lib/stall.ts";

const ctl = (code, area, ce, words) => ({
  code, area, ce_code: ce,
  indicator: Array(words).fill("word").join(" "),
  description: null, active: true,
});
/**
 * Keyed by COMPETENCE ELEMENT code, exactly as lib/framework.ts is.
 *
 * The first version of this stub took a CONTROL code and derived the CE from
 * it — which is precisely the mistake shapeOf was making, so the test agreed
 * with the bug and passed while every row on screen read "4.3.1 4.3.1". A fake
 * that is more forgiving than the real thing tests nothing.
 */
const CE_NAMES = { "1.1.1": "Strategy", "1.1.2": "Governance", "2.1.1": "Design" };
const ceOf = (ceCode) =>
  CE_NAMES[ceCode] ? { code: ceCode, name: CE_NAMES[ceCode] } : undefined;

test("duration scales with the text, not just the count", () => {
  const short = estimateMinutes([ctl("1.1.1.1", "A", "1.1.1", 50)], measureIndex([]));
  const long = estimateMinutes([ctl("1.1.1.1", "A", "1.1.1", 2000)], measureIndex([]));
  assert.ok(long.low > short.low, "more words must cost more minutes");
});

test("the range separates skimming the measures from reading them", () => {
  const c = [ctl("1.1.1.1", "A", "1.1.1", 400)];
  const e = estimateMinutes(c, measureIndex(
    [{ control_code: "1.1.1.1", no: 1, text: Array(400).fill("w").join(" ") }]));
  assert.ok(e.high > e.low, "measures must widen the range");
});

test("a tight range reads as one number, not '5-5'", () => {
  assert.equal(estimateLabel({ low: 5, high: 5 }), "about 5 min");
  assert.equal(estimateLabel({ low: 4, high: 6 }), "about 4–6 min");
});

test("competency names come through — the stub is keyed like the real thing", () => {
  const areas = shapeOf([ctl("1.1.1.1", "People", "1.1.1", 10)], ceOf, [], new Set());
  assert.equal(areas[0].ces[0].name, "Strategy",
    "a name equal to the code means ceOf was called with the wrong key");
});

test("area order follows the framework, not the order controls arrive in", () => {
  const controls = [ctl("2.1.1.1", "Practice", "2.1.1", 10), ctl("1.1.1.1", "People", "1.1.1", 10)];
  const areas = shapeOf(controls, ceOf, [], new Set(), ["People", "Practice"]);
  assert.deepEqual(areas.map((a) => a.name), ["People", "Practice"]);
});

test("a competency finished by skipping is not called complete", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.1.2", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10),
  ];
  // last control of the CE scored, the first skipped
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.1.2"]));
  const b = nextAfter(areas, controls[1]);
  assert.equal(b.complete, false);
  assert.match(b.label, /1 of 2 scored/);
});

test("the end of the assessment carries the save confirmation", () => {
  const controls = [ctl("1.1.1.1", "People", "1.1.1", 10)];
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.1.1"]));
  const b = nextAfter(areas, controls[0]);
  assert.equal(b.done, "assessment");
  assert.match(b.href, /saved=1/, "the 132nd answer must not land silently");
});

test("shape groups by area then competency, in framework order", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 100), ctl("1.1.1.2", "People", "1.1.1", 100),
    ctl("1.1.2.1", "People", "1.1.2", 100), ctl("2.1.1.1", "Practice", "2.1.1", 100),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set());
  assert.deepEqual(areas.map((a) => a.name), ["People", "Practice"]);
  assert.equal(areas[0].ces.length, 2);
  assert.equal(areas[0].controls, 3);
});

test("progress counts scored controls at both levels", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 100), ctl("1.1.1.2", "People", "1.1.1", 100),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.1.1"]));
  assert.equal(areas[0].scored, 1);
  assert.equal(areas[0].ces[0].scored, 1);
  assert.equal(areas[0].ces[0].firstUnscored.code, "1.1.1.2");
});

test("the last control of a competency stops at the competency, not the next one", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.2.1", "People", "1.1.2", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set());
  const b = nextAfter(areas, controls[0]);
  assert.equal(b.done, "ce", "finishing a competency is a boundary");
  assert.match(b.href, /\/assess\/area\//);
});

test("the last competency of an area steps up to the areas screen", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("2.1.1.1", "Practice", "2.1.1", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set());
  const b = nextAfter(areas, controls[0]);
  assert.equal(b.done, "area");
  assert.equal(b.href, "/assess/areas");
});

test("a control mid-competency is not a boundary", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.1.2", "People", "1.1.1", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set());
  assert.equal(nextAfter(areas, controls[0]), null);
});

test("scoredCodes ignores rows with no self_level", () => {
  const set = scoredCodes([
    { control_code: "a", self_level: 3 }, { control_code: "b", self_level: null },
  ]);
  assert.ok(set.has("a") && !set.has("b"));
});

const NOW = Date.parse("2026-08-05T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

test("a draft that has not moved for a week has stalled", () => {
  assert.equal(hasStalled(
    { lastScored: daysAgo(STALL_DAYS), scored: 10, total: 132, state: "draft" }, NOW), true);
});

test("a draft scored yesterday has not", () => {
  assert.equal(hasStalled(
    { lastScored: daysAgo(1), scored: 10, total: 132, state: "draft" }, NOW), false);
});

test("never started is not stalled — it has not stopped, it has not begun", () => {
  assert.equal(hasStalled(
    { lastScored: null, scored: 0, total: 132, state: "draft" }, NOW), false);
});

test("a finished or submitted assessment cannot stall", () => {
  assert.equal(hasStalled(
    { lastScored: daysAgo(30), scored: 132, total: 132, state: "draft" }, NOW), false);
  assert.equal(hasStalled(
    { lastScored: daysAgo(30), scored: 10, total: 132, state: "self_submitted" }, NOW), false);
});

test("daysSince survives a null and a malformed date", () => {
  assert.equal(daysSince(null, NOW), null);
  assert.equal(daysSince("not a date", NOW), null);
});

/* ------------------------------------------------- isComplete (D29 hub) */

test("complete means every active control, and one gap is enough", () => {
  const active = [ctl("1.1.1.1", "A", "1.1.1", 10), ctl("1.1.1.2", "A", "1.1.1", 10)];
  assert.equal(isComplete(active, new Set(["1.1.1.1", "1.1.1.2"])), true);
  assert.equal(isComplete(active, new Set(["1.1.1.1"])), false);
  assert.equal(isComplete(active, new Set()), false);
});

test("an empty framework is not a finished assessment", () => {
  /* [].every() is true, so the naive version put "Review and submit" in front
     of a PM whose framework fetch came back empty — offering to hand a
     zero-control assessment to the Head of PMO. */
  assert.equal(isComplete([], new Set()), false);
  assert.equal(isComplete([], new Set(["1.1.1.1"])), false);
});

test("a scored code that is not in the active list cannot complete it", () => {
  // An inactive control's score must not hold the assessment open OR close it.
  const active = [ctl("1.1.1.1", "A", "1.1.1", 10)];
  assert.equal(isComplete(active, new Set(["9.9.9.9"])), false);
});
