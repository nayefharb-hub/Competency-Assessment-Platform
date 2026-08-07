/**
 * Unit tests for the two pure pieces of the flow work: duration estimates and
 * the area/competency shape. Run with `npm run test:unit`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateMinutes, estimateLabel, measureIndex } from "../lib/duration.ts";
import { shapeOf, nextAfter, ceContextAt, owedAfter, scoredCodes, isComplete } from "../lib/shape.ts";
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

/* ------------------------------------------------ nextAfter / the milestone */

test("a milestone appears only at the LAST control of a competency", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.1.2", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set());
  assert.equal(nextAfter(areas, controls[0]), null, "mid-competency is an ordinary next");
  assert.ok(nextAfter(areas, controls[1]), "the last control ends the competency");
});

test("a competency finished by skipping reports the gap, and the card must not call it complete", () => {
  /* FM1, the worst outcome: telling a PM they finished something they did not,
     and pointing them at a Submit the server will refuse. nextAfter reports
     scored/total and never a verdict, so the caller cannot round it up. */
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.1.2", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10),
  ];
  // last control of the CE scored, the first skipped
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.1.2"]));
  const m = nextAfter(areas, controls[1]);
  assert.equal(m.ce.scored, 1);
  assert.equal(m.ce.total, 2);
  assert.ok(m.ce.scored < m.ce.total, "one skipped control leaves the competency open");
});

test("the milestone reports PERSISTED scores, so the client can add the pending answer", () => {
  /* FM2 — this is N30. The fifth answer is on screen and uncommitted, so the
     server sees 4 of 5. If nextAfter decided completeness itself it would be
     wrong here, every time, on the one screen where it matters. The contract
     is that it reports and does not decide. */
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.1.2", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.1.1"]));
  const m = nextAfter(areas, controls[1]);
  assert.equal(m.ce.scored, 1, "the uncommitted answer is not persisted yet");
  assert.equal(m.ce.total, 2);
  // The client adds 1 for the answer it is holding, and only then is it complete.
  assert.equal(m.ce.scored + 1, m.ce.total);
});

test("continue points at the next competency's first control, across an area boundary", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10),
    ctl("2.1.1.1", "Practice", "2.1.1", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set(), ["People", "Practice"]);

  const withinArea = nextAfter(areas, controls[0]);
  assert.equal(withinArea.done, "ce");
  assert.equal(withinArea.nextControl, "1.1.2.1");
  assert.equal(withinArea.nextCe.name, "Governance");

  const acrossAreas = nextAfter(areas, controls[1]);
  assert.equal(acrossAreas.done, "area", "the last competency of an area ends the area too");
  assert.equal(acrossAreas.area.name, "People");
  assert.equal(acrossAreas.nextControl, "2.1.1.1", "continue crosses into the next area");
  assert.equal(acrossAreas.nextCe.name, "Design");
});

test("Continue skips ahead to what the PM still owes, not to a control they answered", () => {
  /* The header invites jumping around ("you can jump back to any control"), so
     landing on the next competency's FIRST control drops a PM who took that
     invitation onto a pre-filled panel with no explanation. Every other resume
     path in the app uses firstUnscored; this is the same rule. */
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10), ctl("1.1.2.2", "People", "1.1.2", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.2.1"]));
  const m = nextAfter(areas, controls[0]);
  assert.equal(m.nextControl, "1.1.2.2", "1.1.2.1 is already answered — skip it");

  // When the whole next competency is answered there is nowhere better to go.
  const allDone = shapeOf(controls, ceOf, [], new Set(["1.1.2.1", "1.1.2.2"]));
  assert.equal(nextAfter(allDone, controls[0]).nextControl, "1.1.2.1");
});

test("the milestone reports AREA and ASSESSMENT counts, and never a verdict", () => {
  /* `done` is positional. The first cut set `areaDone: area.name` on that basis
     alone and rendered "· People finished", so a PM who skipped a control in an
     earlier competency was told the area was done. The guard that had prevented
     exactly this was deleted rather than moved. These counts are what replaced
     it — the client decides, from persisted + queued. */
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.1.2", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10),
    ctl("2.1.1.1", "Practice", "2.1.1", 10),
  ];
  //                                 1.1.1.1 skipped, so the area is NOT finished
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.1.2", "1.1.2.1"]), ["People", "Practice"]);
  const m = nextAfter(areas, controls[2]);          // last control of 1.1.2 → ends People
  assert.equal(m.done, "area", "positionally, yes");
  assert.equal(m.area.total, 3);
  assert.equal(m.area.scored, 2, "…but one control in this area has no answer");
  assert.equal(m.assessment.total, 4);
  assert.equal(m.assessment.scored, 2);
  assert.ok(!("areaDone" in m), "no field may carry a verdict the server cannot know");
});

test("the end of the assessment has nowhere to continue to, and carries the save confirmation", () => {
  const controls = [ctl("1.1.1.1", "People", "1.1.1", 10)];
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.1.1"]));
  const m = nextAfter(areas, controls[0]);
  assert.equal(m.done, "assessment");
  assert.equal(m.nextControl, null, "there is no next control to continue to");
  assert.equal(m.nextCe, null);
  assert.match(m.listHref, /saved=1/, "the 132nd answer must not land silently");
});

test("the milestone carries the whole competency, in order, for the recap", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.1.2", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set());
  const m = nextAfter(areas, controls[1]);
  assert.deepEqual(m.controls.map((c) => c.code), ["1.1.1.1", "1.1.1.2"]);
  assert.ok(m.controls[0].indicator, "the recap needs something readable, not just a code");
});

test("a control outside the shape produces no milestone rather than throwing", () => {
  const areas = shapeOf([ctl("1.1.1.1", "People", "1.1.1", 10)], ceOf, [], new Set());
  assert.equal(nextAfter(areas, ctl("9.9.9.9", "Nowhere", "9.9.9", 10)), null);
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

test("the last control of a competency ends the competency, and Continue carries on", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.2.1", "People", "1.1.2", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set());
  const m = nextAfter(areas, controls[0]);
  assert.equal(m.done, "ce", "finishing a competency is a moment");
  assert.equal(m.nextControl, "1.1.2.1", "but the run continues — N32");
  // Taking a break still lands on the list that names what was just finished.
  assert.match(m.listHref, /\/assess\/area\//);
});

test("the last competency of an area ends the area, and taking a break goes to the hub", () => {
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("2.1.1.1", "Practice", "2.1.1", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set());
  const m = nextAfter(areas, controls[0]);
  assert.equal(m.done, "area");
  assert.equal(m.area.name, "People");
  assert.equal(m.listHref, "/assess/areas");
});

test("the final competency still recaps itself and reports the assessment's own counts", () => {
  /* The terminal branch used to be tested against a framework of ONE control,
     so the fields the card leans on hardest at the very end — the recap rows
     and the assessment count behind "Every competency scored" — were never
     asserted at all. */
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10), ctl("1.1.1.2", "People", "1.1.1", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.1.1", "1.1.1.2"]));
  const m = nextAfter(areas, controls[1]);
  assert.equal(m.done, "assessment");
  assert.equal(m.area.name, "People");
  assert.deepEqual(m.controls.map((c) => c.code), ["1.1.1.1", "1.1.1.2"]);
  assert.equal(m.assessment.scored, 2);
  assert.equal(m.assessment.total, 2);
  assert.equal(m.nextControl, null);
  assert.equal(m.nextCe, null);
});

test("a skipped control elsewhere keeps the assessment count short of its total", () => {
  /* This is the number that decides whether the card says "Every competency
     scored". A PM who skipped one control in week one and then worked through
     the rest in order reaches the last control positionally — and must not be
     told they are finished, then handed to a Submit the server refuses. */
  const controls = [
    ctl("1.1.1.1", "People", "1.1.1", 10),
    ctl("1.1.2.1", "People", "1.1.2", 10), ctl("1.1.2.2", "People", "1.1.2", 10),
  ];
  const areas = shapeOf(controls, ceOf, [], new Set(["1.1.2.1", "1.1.2.2"]));
  const m = nextAfter(areas, controls[2]);
  assert.equal(m.done, "assessment", "positionally the end");
  assert.equal(m.assessment.total - m.assessment.scored, 1, "…with one control still owed");
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

/* ------------------------------------ ceContextAt / owedAfter (N38, N40) */

/** Two competencies: 1.1.1 has three controls, 1.1.2 has two. */
const FIVE = [
  ctl("1.1.1.1", "People", "1.1.1", 10),
  ctl("1.1.1.2", "People", "1.1.1", 10),
  ctl("1.1.1.3", "People", "1.1.1", 10),
  ctl("1.1.2.1", "People", "1.1.2", 10),
  ctl("1.1.2.2", "People", "1.1.2", 10),
];
const shaped = (scored = new Set()) => shapeOf(FIVE, ceOf, [], scored, ["People"]);

test("the competency is described at EVERY control, not only its last", () => {
  const areas = shaped();
  for (const c of FIVE) {
    const ctx = ceContextAt(areas, c);
    assert.ok(ctx, `${c.code} must know which competency it is in`);
    assert.equal(ctx.ce.code, c.ce_code);
  }
  assert.equal(nextAfter(areas, FIVE[0]), null,
    "nextAfter stays positional — that is still its job");
});

test("mid-competency says so, and still carries the wider counts", () => {
  const ctx = ceContextAt(shaped(), FIVE[0]);
  assert.equal(ctx.done, "mid");
  assert.equal(ctx.ce.total, 3, "it lists the whole competency, not the part behind you");
  assert.equal(ctx.assessment.total, 5);
  assert.equal(ctx.controls.length, 3);
});

test("the last control of a competency is unchanged — still positional", () => {
  const ctx = ceContextAt(shaped(), FIVE[2]);
  assert.equal(ctx.done, "ce");
  assert.equal(ctx.nextCe?.code, "1.1.2", "it names what comes next");
});

test("owed lists what is unanswered AFTER here, then wraps to what is behind", () => {
  // everything answered except the first and the last
  const scored = new Set(["1.1.1.2", "1.1.1.3", "1.1.2.1"]);
  const owed = owedAfter(shaped(scored), scored, FIVE[2]);
  assert.deepEqual(owed, ["1.1.2.2", "1.1.1.1"],
    "forward first, then the hole left behind — a PM mopping up goes forward before back");
});

test("owed excludes nothing on the client's behalf — the caller skips what it holds", () => {
  const scored = new Set();
  const owed = owedAfter(shaped(scored), scored, FIVE[0], 3);
  assert.equal(owed[0], "1.1.1.2");
  assert.equal(owed.length, 3, "several, because the first may be in flight");
});

test("nothing owed is an empty list, which is the only true 'ready to submit'", () => {
  const scored = new Set(FIVE.map((c) => c.code));
  assert.deepEqual(owedAfter(shaped(scored), scored, FIVE[0]), []);
});
