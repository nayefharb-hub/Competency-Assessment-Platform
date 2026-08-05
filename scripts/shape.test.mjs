/**
 * Unit tests for the two pure pieces of the flow work: duration estimates and
 * the area/competency shape. Run with `npm run test:unit`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateMinutes, estimateLabel } from "../lib/duration.ts";
import { shapeOf, nextAfter, scoredCodes } from "../lib/shape.ts";
import { hasStalled, daysSince, STALL_DAYS } from "../lib/stall.ts";

const ctl = (code, area, ce, words) => ({
  code, area, ce_code: ce,
  indicator: Array(words).fill("word").join(" "),
  description: null, active: true,
});
const ceOf = (code) => ({ code: code.split(".").slice(0, 3).join("."), name: "Named" });

test("duration scales with the text, not just the count", () => {
  const short = estimateMinutes([ctl("1.1.1.1", "A", "1.1.1", 50)], []);
  const long = estimateMinutes([ctl("1.1.1.1", "A", "1.1.1", 2000)], []);
  assert.ok(long.low > short.low, "more words must cost more minutes");
});

test("the range separates skimming the measures from reading them", () => {
  const c = [ctl("1.1.1.1", "A", "1.1.1", 400)];
  const e = estimateMinutes(c, [{ control_code: "1.1.1.1", no: 1, text: Array(400).fill("w").join(" ") }]);
  assert.ok(e.high > e.low, "measures must widen the range");
});

test("a tight range reads as one number, not '5-5'", () => {
  assert.equal(estimateLabel({ low: 5, high: 5 }), "about 5 min");
  assert.equal(estimateLabel({ low: 4, high: 6 }), "about 4–6 min");
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
