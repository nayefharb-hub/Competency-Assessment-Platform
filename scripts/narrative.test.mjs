/**
 * Unit tests for lib/narrative.ts — the deterministic sentence templates on the
 * results screen. These assert that every narrative line is a faithful view of
 * the rollup numbers: the right control named, the right count, the right verdict
 * phrase, and actions phrased as suggestions (the tool supports a decision, never
 * gates one). Run with `npm run test:unit`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  areaNarrative, gapSummary, gapsOf, strengthSummary, strengthsOf, tidyIndicator,
} from "../lib/narrative.ts";

function ce(o) {
  return {
    ce_code: "4.4.1", ce_name: "CE", area: "People",
    target: 3, actual: 3, gap: 0, health: "ready",
    weakest: null, escalated_by: [], escalation_drove_health: false,
    scored_controls: 5, active_controls: 5, ...o,
  };
}
function area(o) {
  return { area: "People", target: 3, actual: 3, ce_count: 2, ...o };
}

test("area with no gaps reports at-or-above target and counts the ones clear of it", () => {
  const ces = [ce({ health: "ready" }), ce({ ce_code: "4.4.2", health: "above" })];
  const s = areaNarrative(area({ actual: 3.5, target: 3 }), ces);
  assert.ok(s.includes("at or above target across all 2 competencies"), s);
  assert.ok(s.includes("1 of them a full level or more clear"), s);
  assert.ok(s.includes("3.5 vs 3.0 target"), s);
});

test("area with gaps names the most serious gap and counts the rest", () => {
  const ces = [
    ce({ ce_code: "4.4.1", ce_name: "Teamwork", health: "deficit", actual: 1.5, target: 3, gap: 1.5 }),
    ce({ ce_code: "4.4.2", ce_name: "Leadership", health: "minor", actual: 2.6, target: 3, gap: 0.4 }),
  ];
  const s = areaNarrative(area({ actual: 2.0, target: 3.0 }), ces);
  assert.ok(s.includes("the main gap is Teamwork,"), s); // deficit leads, not the minor
  assert.ok(s.includes("and 1 other"), s);
  assert.ok(s.includes("below target overall"), s); // gap of a full level is more than half
});

test("an unscored area says so rather than inventing a number", () => {
  const s = areaNarrative(area({ actual: null, target: null }), []);
  assert.ok(s.includes("not yet scored"), s);
});

test("area narrative names the escalating control by its indicator text, not its code", () => {
  const ces = [
    ce({
      ce_code: "4.4.1", ce_name: "Leadership", health: "deficit",
      actual: 3.0, target: 3, gap: 0,
      escalation_drove_health: true,
      escalated_by: [{ control_code: "4.4.1.2", level: 1, target: 3 }],
    }),
  ];
  const label = (code) => (code === "4.4.1.2" ? "Take ownership and show commitment" : code);
  const s = areaNarrative(area({ actual: 3.0, target: 3.0, ce_count: 1 }), ces, label);
  assert.ok(s.includes("Take ownership and show commitment"), s);
  assert.ok(!s.includes("4.4.1.2"), `must not print the raw control code: ${s}`);
});

test("tidyIndicator strips the extractor's trailing OCR boilerplate", () => {
  // The real contaminated cells from data/seed/icb4-framework.json (4.5.13.4 is
  // 394 chars, active, target 2 — reaches the screen as a weakest/escalating control).
  assert.equal(
    tidyIndicator("Implement change or transformation management strategy Version 4.0 www.ipma.world ® MOVING FORWARD The International Project Management Association Version 4.0."),
    "Implement change or transformation management strategy",
  );
  assert.equal(
    tidyIndicator("Share own vision and goals in order to gain the engagement and commitment of others © 2015 International Project Management Association"),
    "Share own vision and goals in order to gain the engagement and commitment of others",
  );
  assert.equal(
    tidyIndicator("Determine complexity and its consequences for the approach 119 © 2015 International Project Management Association"),
    "Determine complexity and its consequences for the approach",
  );
});

test("tidyIndicator leaves a clean indicator untouched", () => {
  const clean = "Align with organisational mission and vision";
  assert.equal(tidyIndicator(clean), clean);
  // a legitimately long-but-clean indicator is not truncated by tidy (that is clip()'s job)
  const long = "Identify and ensure that the project complies with all relevant health, safety, security and environmental regulations (HSSE)";
  assert.equal(tidyIndicator(long), long);
});

test("gapsOf keeps only gap competencies, deficits before minors, then by gap", () => {
  const rows = [
    ce({ ce_code: "a", health: "minor", gap: 0.4 }),
    ce({ ce_code: "b", health: "deficit", gap: 0.2 }),
    ce({ ce_code: "c", health: "ready", gap: -1 }),
    ce({ ce_code: "d", health: "deficit", gap: 1.0 }),
    ce({ ce_code: "e", health: "above", gap: -2 }),
  ];
  assert.deepEqual(gapsOf(rows).map((r) => r.ce_code), ["d", "b", "a"]);
});

// strengthsOf is gapsOf's mirror for the ?view=gaps strengths column: only
// above/ready, most clear of target first (gap ascending — a more-negative gap
// is further above). It must NOT include minor/deficit, must order the most
// clear first, and must break ties on ce_code so the order is total.
test("strengthsOf keeps only above/ready, most clear of target first, ties by code", () => {
  const rows = [
    ce({ ce_code: "a", health: "minor", gap: 0.4 }),
    ce({ ce_code: "b", health: "ready", gap: 0 }),
    ce({ ce_code: "c", health: "above", gap: -1.5 }),
    ce({ ce_code: "d", health: "deficit", gap: 1.0 }),
    ce({ ce_code: "z", health: "above", gap: -2 }),
    ce({ ce_code: "e", health: "above", gap: -2 }),
  ];
  // -2 (tie z,e → e before z by code), then -1.5, then 0. No minor/deficit.
  assert.deepEqual(strengthsOf(rows).map((r) => r.ce_code), ["e", "z", "c", "b"]);
});

// gapsOf's final tiebreak makes the order total: two equal-severity, equal-gap
// competencies order by ce_code, not by input position (a reordered rollupAll
// must not change the display order).
test("gapsOf breaks equal severity+gap ties by ce_code, not input order", () => {
  const rows = [
    ce({ ce_code: "z", health: "minor", gap: 0.4 }),
    ce({ ce_code: "a", health: "minor", gap: 0.4 }),
    ce({ ce_code: "m", health: "minor", gap: 0.4 }),
  ];
  assert.deepEqual(gapsOf(rows).map((r) => r.ce_code), ["a", "m", "z"]);
});

// gapSummary reads the control breakdown, not the CE mean: it counts the controls
// actually below their own target and states how far down the worst is. "levels
// down" is an integer difference of integer levels, so it is exact.
test("gapSummary counts controls below target and names the worst shortfall", () => {
  const controls = [
    { code: "x.1", level: 1, target: 3, health: "deficit", below: true },  // 2 down
    { code: "x.2", level: 2, target: 3, health: "minor", below: true },    // 1 down
    { code: "x.3", level: 3, target: 3, health: "ready", below: false },   // on target
  ];
  assert.equal(gapSummary({ actual: 2.0, target: 3.0 }, controls), "2 controls below target · weakest 2 levels down");
});

test("gapSummary singularises one control one level down", () => {
  const controls = [
    { code: "x.1", level: 2, target: 3, health: "minor", below: true },
    { code: "x.2", level: 4, target: 4, health: "ready", below: false },
  ];
  assert.equal(gapSummary({ actual: 3.0, target: 3.5 }, controls), "1 control below target · weakest 1 level down");
});

// The edge the review caught: a competency can be a gap (mean below target) while
// NO single control is below its own target — an untargeted or post-approval
// newly-active control drags the mean down. gapSummary must describe the mean,
// never render "0 controls below target" over an empty list.
test("gapSummary describes the element mean when no control is individually below target", () => {
  const controls = [
    { code: "x.1", level: 3, target: 3, health: "ready", below: false },  // on target
    { code: "x.2", level: 1, target: null, health: null, below: false },  // untargeted, low
  ];
  assert.equal(gapSummary({ actual: 2.0, target: 3.0 }, controls), "element mean 2.0 below the 3.0 target");
});

// strengthSummary is gapSummary's mirror for the strengths column: how many
// controls are at or above their own target, and how far up the strongest is.
test("strengthSummary counts controls at/above target and names the strongest margin", () => {
  const controls = [
    { code: "x.1", level: 5, target: 2, health: "above", below: false },  // 3 up
    { code: "x.2", level: 3, target: 3, health: "ready", below: false },  // at target
    { code: "x.3", level: 4, target: 3, health: "above", below: false },  // 1 up
  ];
  assert.equal(strengthSummary(controls), "all 3 controls at or above target · strongest 3 levels up");
});

// A strength is judged on its MEAN, so it can still hold a below-target control
// (not 2+ down, or it would escalate out of the strengths column). The wording
// must stay honest — "M of N", never "all N".
test("strengthSummary says 'M of N' when a strength still holds a below-target control", () => {
  const controls = [
    { code: "x.1", level: 4, target: 3, health: "above", below: false },  // 1 up
    { code: "x.2", level: 2, target: 3, health: "minor", below: true },   // 1 down
  ];
  assert.equal(strengthSummary(controls), "1 of 2 at or above target · strongest 1 level up");
});

// Exactly at target on every control: no "levels up" clause, since best margin is 0.
test("strengthSummary omits the margin clause when nothing is strictly above target", () => {
  const controls = [
    { code: "x.1", level: 3, target: 3, health: "ready", below: false },
    { code: "x.2", level: 2, target: 2, health: "ready", below: false },
  ];
  assert.equal(strengthSummary(controls), "all 2 controls at or above target");
});

// Regression (/review 2026-08-10): the top gap in an area can be an
// escalation-driven deficit whose MEAN is at or above target. The old line
// printed "<actual> against <target>" for it — e.g. "3.4 against 3.0" — labelling
// a competency whose mean exceeds target as "the main gap", the number
// contradicting the verdict. It must name the escalating control instead, and
// never print a mean-above-target "X against Y". (Default identity label here,
// so the control appears by code; the real screen passes indicator text.)
test("area narrative describes an escalation-driven top gap by its control, not a mean above target", () => {
  const ces = [
    ce({
      ce_code: "4.4.1", ce_name: "Leadership", health: "deficit",
      actual: 3.4, target: 3, gap: -0.4,
      escalation_drove_health: true,
      escalated_by: [{ control_code: "4.4.1.5", level: 1, target: 3 }],
    }),
    ce({ ce_code: "4.4.2", ce_name: "Teamwork", health: "minor", actual: 2.6, target: 3, gap: 0.4 }),
  ];
  const s = areaNarrative(area({ actual: 3.0, target: 3.0 }), ces);
  assert.ok(!s.includes("3.4 against 3.0"), `must not label a mean above target as the gap: ${s}`);
  assert.ok(s.includes("4.4.1.5"), `must name the escalating control: ${s}`);
  assert.ok(/held in deficit by/.test(s), s);
  assert.ok(s.includes("and 1 other"), s);
});
