/**
 * Unit tests for lib/narrative.ts — the deterministic sentence templates on the
 * results screen. These assert that every narrative line is a faithful view of
 * the rollup numbers: the right control named, the right count, the right verdict
 * phrase, and actions phrased as suggestions (the tool supports a decision, never
 * gates one). Run with `npm run test:unit`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { areaNarrative, ceNarrative, suggestedAction, gapsOf } from "../lib/narrative.ts";

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
  assert.ok(s.includes("the main gap is Teamwork (4.4.1)"), s); // deficit leads, not the minor
  assert.ok(s.includes("and 1 other"), s);
  assert.ok(s.includes("below target overall"), s); // gap of a full level is more than half
});

test("an unscored area says so rather than inventing a number", () => {
  const s = areaNarrative(area({ actual: null, target: null }), []);
  assert.ok(s.includes("not yet scored"), s);
});

test("ceNarrative names the escalating control when escalation drove the verdict", () => {
  const r = ce({
    health: "deficit", actual: 3.0, target: 3,
    escalation_drove_health: true,
    escalated_by: [{ control_code: "4.4.1.2", level: 1, target: 3 }],
  });
  assert.ok(
    ceNarrative(r).includes("The mean is on target, but 4.4.1.2 scored 1 against a target of 3"),
    ceNarrative(r),
  );
});

test("ceNarrative names the weakest control when the mean itself is short", () => {
  const r = ce({ health: "minor", actual: 2.4, target: 3, gap: 0.6, weakest: { control_code: "4.4.1.3", level: 2 } });
  assert.ok(ceNarrative(r).includes("Weakest control 4.4.1.3 at 2"), ceNarrative(r));
});

test("suggested actions are suggestions, never mandates", () => {
  const esc = ce({
    health: "deficit", escalation_drove_health: true,
    escalated_by: [{ control_code: "4.4.1.2", level: 1, target: 3 }],
  });
  assert.match(suggestedAction(esc), /^Consider prioritising 4\.4\.1\.2/);
  const weak = ce({ health: "minor", weakest: { control_code: "4.4.1.3", level: 2 } });
  assert.match(suggestedAction(weak), /^Consider focused development on 4\.4\.1\.3/);
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

// Regression (/review 2026-08-10): the top gap in an area can be an
// escalation-driven deficit whose MEAN is at or above target. The old line
// printed "<actual> against <target>" for it — e.g. "3.4 against 3.0" — labelling
// a competency whose mean exceeds target as "the main gap", the number
// contradicting the verdict. It must name the escalating control instead, the
// same way ceNarrative does, and never print a mean-above-target "X against Y".
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
