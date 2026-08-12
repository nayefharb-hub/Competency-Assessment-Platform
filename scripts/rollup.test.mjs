/**
 * Unit tests for the rollup engine — the arithmetic behind every number on the
 * results screen. Run with `npm run test:unit`.
 *
 * WHY THIS FILE EXISTS AT ALL. Until 2026-08-08 the engine had no unit tests:
 * `test:unit` covered ttl-map, shape, pace, routes, outbox, commit-label and
 * control-filter, and the only thing checking the rollup was an e2e section that
 * recomputed the means from the database. That was acceptable while the rule was
 * "read a stored integer"; it stopped being acceptable when the rule became a
 * computation (rollup-spec §3).
 *
 * The contract is docs/rollup-spec.md. Change that file first, then lib/rollup.ts,
 * then this one.
 *
 * Three of these exist because of specific ways this could break silently:
 *
 *   - THE HEADLINE REGRESSION (test 1) is the whole reason for the change: a PM
 *     who hit every single control target was told Minor Gap on 4 of 28
 *     competencies, because a fractional actual was compared against an
 *     unrelated integer. It was RED on 6a4be6c before the engine changed.
 *   - THE SNAPSHOT MUST WIN (test 5). Nothing else stops a future
 *     "simplification" from reading fw.ce_targets in rollupCe, which knows
 *     nothing about target_snapshot and would let a benchmark change move a
 *     historic gap.
 *   - THE HALF-LEVEL BOUNDARY IS NOT FLOAT-SAFE (test 7). Once BOTH sides are
 *     means, a gap of exactly half a level can compute as a hair over it. Same
 *     trap class as `target=0` in control-filter: the value is legal, the
 *     comparison is not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ceTargetOf, healthOf, rollupCe, rollupAll, rollupAreas, sortByGap, fmtLevel,
  activeControlsOf,
} from "../lib/rollup.ts";

/* ------------------------------------------------------------------ fixtures */

/**
 * A framework shaped like the real one: controls carry ce_code/active/
 * target_level, competence_elements carry code/name/area, and ce_targets carries
 * the APM published value the engine used to read. The published value is kept
 * in the fixture ON PURPOSE and set to something the mean does NOT equal — a
 * fixture where the two agree would pass whichever number the engine used.
 *
 *   spec:  [{ ce: "4.3.1", area: "Perspective", published: 3,
 *             controls: [[target, active?], ...] }]
 */
function frameworkOf(spec) {
  const controls = [];
  const competence_elements = [];
  const ce_targets = [];
  for (const s of spec) {
    let n = 0;
    for (const [target, active = true] of s.controls) {
      n += 1;
      controls.push({
        id: `${s.ce}.${n}-id`,
        code: `${s.ce}.${n}`,
        ce_code: s.ce,
        area: s.area,
        indicator: `indicator ${s.ce}.${n}`,
        description: null,
        active,
        priority: "High",
        reason: null,
        kib_note: null,
        apm_competence: null,
        target_level: target,
        target_label: target === null ? null : String(target),
        target_source: "APM (published)",
      });
    }
    competence_elements.push({
      id: `${s.ce}-id`,
      code: s.ce,
      name: s.name ?? `CE ${s.ce}`,
      area: s.area,
      declared_controls: s.controls.filter(([, a = true]) => a).length,
    });
    ce_targets.push({
      area: s.area,
      ce_code: s.ce,
      ce_name: s.name ?? `CE ${s.ce}`,
      active_controls: s.controls.filter(([, a = true]) => a).length,
      target: s.published,
    });
  }
  return {
    source_file: "test",
    framework: "IPMA ICB4 v4.0.1",
    scale: { name: "APM", axis: "Application", levels: [] },
    areas: [
      { code: "P1", name: "Perspective" },
      { code: "P2", name: "People" },
      { code: "P3", name: "Practice" },
    ],
    competence_elements,
    controls,
    measures: [],
    ce_targets,
  };
}

/** scores: { "4.3.1.1": 3, ... } — anything omitted is unscored, not zero. */
function assessmentOf(scores, snapshot_targets = undefined) {
  return {
    id: "a-id",
    assessee_id: "u-id",
    assessee_name: "Test PM",
    assessee_role: "Project Manager",
    cycle: "2026",
    profile_id: "p-id",
    state: "approved",
    scores: Object.entries(scores).map(([control_code, assessor_level]) => ({
      control_code,
      self_level: assessor_level,
      assessor_level,
      assessor_touched: false,
      evidence: null,
    })),
    started_at: null,
    submitted_at: null,
    approved_at: null,
    completed_at: null,
    snapshot_targets,
  };
}

const approx = (a, b, msg) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${msg}: expected ~${b}, got ${a}`);

/* ------------------------------------------------------------ 1. regression */

/*
 * 4.3.2 in miniature. Its six active controls target 3,3,3,3,2,2 against a
 * published CE target of 3, so a PM who scores exactly the target on every
 * control lands on 2.667 and used to be told Minor Gap — falling short of a
 * competency while having done precisely what was asked of them on every part
 * of it. This is the defect the change exists to remove.
 *
 * SHOWN RED on 6a4be6c before lib/rollup.ts changed:
 *   AssertionError: a PM who hits every control target is Role Ready
 *   + actual - expected  ... 'minor' !== 'ready'
 */
test("a PM who hits every control target is Role Ready, not Minor Gap", () => {
  const fw = frameworkOf([
    { ce: "4.3.2", area: "Perspective", published: 3, controls: [[3], [3], [2]] },
  ]);
  const a = assessmentOf({ "4.3.2.1": 3, "4.3.2.2": 3, "4.3.2.3": 2 });
  const r = rollupCe(fw, a, "4.3.2");

  approx(r.target, 8 / 3, "CE target is the mean of its control targets");
  approx(r.actual, 8 / 3, "actual equals the target when every control is hit");
  approx(r.gap, 0, "no gap");
  assert.equal(r.health, "ready");
});

/* --------------------------------------------------- 2-4. ceTargetOf itself */

test("inactive controls contribute nothing to the CE target", () => {
  // the inactive control carries an outlier target: if it leaked into the mean
  // the answer would be 3.0 instead of 2.0, which is the whole point of `active`
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[2], [2], [5, false]] },
  ]);
  const r = rollupCe(fw, assessmentOf({ "4.3.1.1": 2, "4.3.1.2": 2 }), "4.3.1");
  approx(r.target, 2, "target ignores the inactive control");
  assert.equal(r.active_controls, 2);
  assert.equal(r.health, "ready");
});

test("an active control with no target is skipped, not counted as zero", () => {
  // published is 5 so this cannot pass by agreeing with the OLD rule: counting
  // the untargeted control as zero would give 2.0, reading it would give 5.0,
  // and the answer is 3.0.
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 5, controls: [[3], [3], [null]] },
  ]);
  const r = rollupCe(fw, assessmentOf({ "4.3.1.1": 3, "4.3.1.2": 3, "4.3.1.3": 3 }), "4.3.1");
  approx(r.target, 3, "mean of the two controls that HAVE a target");
});

test("no active control with a target gives a null target, never 0", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[null], [null]] },
  ]);
  const r = rollupCe(fw, assessmentOf({ "4.3.1.1": 2, "4.3.1.2": 2 }), "4.3.1");
  assert.equal(r.target, null);
  assert.equal(r.health, null, "no target means no verdict, not a passing one");
  assert.equal(r.gap, null);
  assert.equal(fmtLevel(r.target), "—");
});

test("ceTargetOf is callable directly and states the active rule once", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[4], [2], [5, false]] },
  ]);
  const all = fw.controls.filter((c) => c.ce_code === "4.3.1");
  approx(ceTargetOf(all, (c) => c.target_level), 3, "mean of the two active");
  assert.equal(ceTargetOf([], (c) => c.target_level), null);
  assert.equal(
    ceTargetOf(all.filter((c) => !c.active), (c) => c.target_level),
    null,
    "handed ONLY inactive controls it returns null — the filter is INSIDE ceTargetOf, "
      + "so no caller can forget it",
  );
});

/* ------------------------------------------------------------- 5. snapshot */

/*
 * rollup-spec §6. The frozen targets differ from the live framework in both
 * directions, so a rollup that read the live values would be wrong by a
 * measurable amount rather than coincidentally right.
 */
test("an approved assessment's CE target comes from the snapshot, not the live framework", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [3], [3]] },
  ]);
  const scores = { "4.3.1.1": 2, "4.3.1.2": 2, "4.3.1.3": 2 };

  const live = rollupCe(fw, assessmentOf(scores), "4.3.1");
  approx(live.target, 3, "before approval, the live framework");
  assert.equal(live.health, "deficit", "gap of 1.0");

  const frozen = rollupCe(
    fw,
    assessmentOf(scores, { "4.3.1.1": 2, "4.3.1.2": 2, "4.3.1.3": 2 }),
    "4.3.1",
  );
  approx(frozen.target, 2, "after approval, the frozen values");
  assert.equal(frozen.health, "ready", "the PM met the bar that applied at the time");
});

test("a snapshot that omits a control falls back to the live target for that one", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[4], [2]] },
  ]);
  // only .1 was frozen; .2 keeps its live target of 2
  const r = rollupCe(fw, assessmentOf({ "4.3.1.1": 2, "4.3.1.2": 2 }, { "4.3.1.1": 2 }), "4.3.1");
  approx(r.target, 2, "mean of frozen 2 and live 2");
});

/* --------------------------------------------- 6-7. the health thresholds */

test("the gap is computed before rounding, not after", () => {
  // target 2.6, actual 2.2 -> gap 0.4 -> Minor Gap.
  // Rounding the target to 3 first would make it 0.8 and a Capability Deficit.
  const fw = frameworkOf([
    { ce: "4.5.8", area: "Practice", published: 3, controls: [[3], [3], [3], [2], [2]] },
  ]);
  const r = rollupCe(
    fw,
    assessmentOf({ "4.5.8.1": 3, "4.5.8.2": 2, "4.5.8.3": 2, "4.5.8.4": 2, "4.5.8.5": 2 }),
    "4.5.8",
  );
  approx(r.target, 2.6, "target");
  approx(r.actual, 2.2, "actual");
  assert.equal(r.health, "minor", "0.4 is inside half a level");
});

/*
 * THE FLOAT BOUNDARY. Six controls targeting 2,2,2,2,2,4 (mean 14/6) against
 * scores summing to 11 (mean 11/6). The gap is exactly 3/6 = half a level, so
 * the verdict is Minor Gap — but in IEEE754,
 *
 *   14/6 - 11/6  ===  0.5000000000000002
 *
 * and a bare `gap <= 0.5` reads that as a Capability Deficit. The scores are
 * chosen so no control sits 2+ levels below its own target, or escalation would
 * produce "deficit" for an unrelated reason and the test would pass while
 * proving nothing.
 *
 * Enumerated over every target/actual multiset for CE sizes 3-8: 972 pairs are
 * affected. Sizes 3 and 5 can never produce an exact half; size 4 divides
 * exactly in binary. Only sizes 6, 7 and 8 are exposed — of which today's
 * framework has three (all currently clean), and all 133 targets are about to
 * be re-baselined by hand.
 */
test("a gap of exactly half a level is a Minor Gap even when the float says otherwise", () => {
  const fw = frameworkOf([
    { ce: "4.4.1", area: "People", published: 3, controls: [[2], [2], [2], [2], [2], [4]] },
  ]);
  const r = rollupCe(
    fw,
    assessmentOf({
      "4.4.1.1": 1, "4.4.1.2": 2, "4.4.1.3": 2,
      "4.4.1.4": 2, "4.4.1.5": 1, "4.4.1.6": 3,
    }),
    "4.4.1",
  );
  assert.equal(r.escalated_by.length, 0, "no control is 2+ below its own target");
  assert.equal(r.target, 14 / 6);
  assert.equal(r.actual, 11 / 6);
  assert.ok(r.gap > 0.5, `the raw float IS over the line: ${r.gap}`);
  assert.equal(r.health, "minor", "but half a level is half a level");
});

test("healthOf separates all four tiers on unambiguous input", () => {
  assert.equal(healthOf(4, 3, false), "above", "a full level clear of target is Above target");
  assert.equal(healthOf(3, 2.5, false), "ready", "half a level above is still only Role Ready");
  assert.equal(healthOf(2.5, 2.5, false), "ready");
  assert.equal(healthOf(2.2, 2.6, false), "minor");
  assert.equal(healthOf(2.0, 2.6, false), "deficit");
  assert.equal(healthOf(3.0, 2.5, true), "deficit", "escalation overrides a clear pass");
  assert.equal(healthOf(null, 2.5, false), null);
  assert.equal(healthOf(2.5, null, false), null);
});

/* -------------------------------------------------- 7b. the Above-target tier */

/**
 * Added 2026-08-10 with the 4th tier (rollup-spec §4). Role Ready used to be
 * everything at or above target; it now stops just short of a full level above,
 * and "Above target" begins at exactly one full level clear.
 */
test("Above target begins at a full level clear, and escalation still outranks it", () => {
  assert.equal(healthOf(4, 3, false), "above", "exactly one level above");
  assert.equal(healthOf(3.5, 2.5, false), "above");
  assert.equal(healthOf(5, 3, false), "above", "more than a level above");
  // just short of a full level is Role Ready, not Above
  assert.equal(healthOf(3.4, 2.5, false), "ready", "0.9 above is not a full level");
  assert.equal(healthOf(3, 3, false), "ready", "exactly at target is Role Ready, never Above");
  // a severe single control is a Capability Deficit even a full level above the mean
  assert.equal(healthOf(4.5, 3, true), "deficit", "escalation beats a full level above");
});

/**
 * The FULL_LEVEL boundary is not float-safe on its own — the mirror of test 7.
 * Both gap sides are means since §3, so an actual that is EXACTLY one level above
 * target can compute a hair under 1.0: 13/6 - 7/6 is 0.9999999999999998, and a
 * bare `>= 1.0` would drop it back to Role Ready. Scores are chosen so no control
 * sits below its own target, or escalation would decide the verdict instead.
 */
test("an actual exactly one level above target reads Above despite float underflow", () => {
  const fw = frameworkOf([
    { ce: "4.4.2", area: "People", published: 2, controls: [[1], [1], [1], [1], [1], [2]] },
  ]);
  const r = rollupCe(
    fw,
    assessmentOf({
      "4.4.2.1": 2, "4.4.2.2": 2, "4.4.2.3": 2,
      "4.4.2.4": 2, "4.4.2.5": 2, "4.4.2.6": 3,
    }),
    "4.4.2",
  );
  assert.equal(r.escalated_by.length, 0, "no control is below its own target");
  assert.equal(r.target, 7 / 6);
  assert.equal(r.actual, 13 / 6);
  assert.ok(r.actual - r.target < 1, `the raw float is a hair under a full level: ${r.actual - r.target}`);
  assert.equal(r.health, "above", "one full level above is Above target even when the float says 0.999…");
});

/* ---------------------------------------------------------- 8. escalation */

test("escalation still fires and still reports an INTEGER control target", () => {
  const fw = frameworkOf([
    { ce: "4.3.3", area: "Perspective", published: 3, controls: [[3], [3], [3], [3], [3]] },
  ]);
  const r = rollupCe(
    fw,
    assessmentOf({
      "4.3.3.1": 1, "4.3.3.2": 5, "4.3.3.3": 5, "4.3.3.4": 5, "4.3.3.5": 5,
    }),
    "4.3.3",
  );
  assert.equal(r.health, "deficit");
  assert.equal(r.escalation_drove_health, true, "the mean of 4.2 clears the target of 3");
  assert.deepEqual(r.escalated_by, [{ control_code: "4.3.3.1", level: 1, target: 3 }]);
  assert.equal(
    Number.isInteger(r.escalated_by[0].target),
    true,
    "a CONTROL target is a level, never the CE's fractional mean",
  );
});

test("the escalation explanation stays off rows the mean already condemns", () => {
  const fw = frameworkOf([
    { ce: "4.3.3", area: "Perspective", published: 3, controls: [[3], [3], [3]] },
  ]);
  const r = rollupCe(fw, assessmentOf({ "4.3.3.1": 1, "4.3.3.2": 1, "4.3.3.3": 1 }), "4.3.3");
  assert.equal(r.health, "deficit");
  assert.equal(
    r.escalation_drove_health,
    false,
    "the mean is 2 levels short on its own — the badge needs no defence",
  );
});

/* ------------------------------------------------------ 9. areas and order */

test("area tiles average the fractional CE targets", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [3], [2]] },
    { ce: "4.3.2", area: "Perspective", published: 3, controls: [[2], [2]] },
    { ce: "4.4.1", area: "People", published: 2, controls: [[2], [2]] },
  ]);
  const a = assessmentOf({
    "4.3.1.1": 3, "4.3.1.2": 3, "4.3.1.3": 2,
    "4.3.2.1": 2, "4.3.2.2": 2,
    "4.4.1.1": 2, "4.4.1.2": 2,
  });
  const areas = rollupAreas(rollupAll(fw, a));
  const persp = areas.find((x) => x.area === "Perspective");
  approx(persp.target, (8 / 3 + 2) / 2, "mean of two fractional CE targets");
  assert.equal(persp.ce_count, 2);
  const practice = areas.find((x) => x.area === "Practice");
  assert.equal(practice.target, null, "an area with no CEs has no target");
});

test("a CE with no scored control is unscored, and sorts last", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [3]] },
    { ce: "4.3.2", area: "Perspective", published: 3, controls: [[3], [3]] },
  ]);
  const results = rollupAll(fw, assessmentOf({ "4.3.1.1": 1, "4.3.1.2": 1 }));
  const unscored = results.find((r) => r.ce_code === "4.3.2");
  assert.equal(unscored.actual, null);
  assert.equal(unscored.health, null);
  approx(unscored.target, 3, "the target exists even when nothing is scored");
  assert.equal(sortByGap(results).at(-1).ce_code, "4.3.2");
});

test("activeControlsOf and the CE target agree on which controls count", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [3], [3, false]] },
  ]);
  assert.equal(activeControlsOf(fw, "4.3.1").length, 2);
  assert.equal(rollupCe(fw, assessmentOf({}), "4.3.1").active_controls, 2);
});

test("fmtLevel renders one decimal, and an em dash for nothing", () => {
  assert.equal(fmtLevel(8 / 3), "2.7");
  assert.equal(fmtLevel(2), "2.0");
  assert.equal(fmtLevel(null), "—");
});

/* ------------------------------------------------ 10. the surrounding behaviour
 *
 * ADDED AFTER A MUTATION AUDIT, 2026-08-08. The tests above cover the new
 * arithmetic thoroughly and everything AROUND it not at all — even though the
 * change altered the inputs to all of it. Eight single-line mutations of
 * lib/rollup.ts survived the first sixteen tests, including three that produce
 * visibly wrong output on the results screen. Each test below was confirmed to
 * FAIL against its own mutation before being kept.
 *
 * The lesson is worth more than the tests: "the diff only touched the target"
 * is not a reason to test only the target. It is a reason to test everything
 * downstream of it.
 */

test("the weakest control is the LOWEST-scoring one, ties by control code", () => {
  // Mutation caught: `s.level < weakest.level` -> `>`, which reports the
  // strongest control as the weakest. Nothing asserted `weakest` before —
  // scripts/e2e.mjs only checks that the word appears on the page.
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [3], [3], [3]] },
  ]);
  const r = rollupCe(
    fw,
    assessmentOf({ "4.3.1.1": 4, "4.3.1.2": 1, "4.3.1.3": 5, "4.3.1.4": 1 }),
    "4.3.1",
  );
  assert.equal(r.weakest.level, 1, "the lowest score, not the highest");
  assert.equal(r.weakest.control_code, "4.3.1.2", "ties resolve to the lowest code");
});

test("escalated_by is ordered worst shortfall first, so the results row names the right control", () => {
  // Mutation caught: reversing the comparator. app/results/page.tsx renders
  // escalated_by[0] only, so the wrong order makes the page name the LEAST
  // severe control — the exact thing the comment beside the sort forbids.
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [5], [4], [3]] },
  ]);
  const r = rollupCe(
    fw,
    assessmentOf({ "4.3.1.1": 1, "4.3.1.2": 0, "4.3.1.3": 2, "4.3.1.4": 5 }),
    "4.3.1",
  );
  assert.deepEqual(
    r.escalated_by.map((e) => e.control_code),
    ["4.3.1.2", "4.3.1.1", "4.3.1.3"],
    "shortfalls 5, 2, 2 — worst first, then by code",
  );
});

test("escalation_drove_health is true when escalation turned MINOR into deficit", () => {
  // Mutation caught: `withoutEscalation !== "deficit"` -> `=== "ready"`, which
  // silences the explanation on every row where the mean was a Minor Gap and
  // escalation pushed it to deficit — a case spec §4 requires explaining.
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [3], [3], [3]] },
  ]);
  const r = rollupCe(
    fw,
    assessmentOf({ "4.3.1.1": 1, "4.3.1.2": 3, "4.3.1.3": 3, "4.3.1.4": 3 }),
    "4.3.1",
  );
  approx(r.target, 3, "target");
  approx(r.actual, 2.5, "actual — a Minor Gap on its own");
  assert.equal(r.health, "deficit");
  assert.equal(r.escalation_drove_health, true, "minor -> deficit still needs explaining");
});

test("sortByGap puts the BIGGEST gap first", () => {
  // Mutation caught: `b.gap - a.gap` -> `a.gap - b.gap`, which inverts the
  // results list against its own caption. The only prior assertion checked that
  // the unscored CE sorts last, which is true in either direction.
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [3]] },
    { ce: "4.3.2", area: "Perspective", published: 3, controls: [[3], [3]] },
    { ce: "4.3.3", area: "Perspective", published: 3, controls: [[3], [3]] },
  ]);
  const results = rollupAll(fw, assessmentOf({
    "4.3.1.1": 3, "4.3.1.2": 3,   // gap 0
    "4.3.2.1": 0, "4.3.2.2": 0,   // gap 3
    "4.3.3.1": 2, "4.3.3.2": 2,   // gap 1
  }));
  assert.deepEqual(
    sortByGap(results).map((r) => r.ce_code),
    ["4.3.2", "4.3.3", "4.3.1"],
    "biggest gap first — 'where are the gaps' is the question the list answers",
  );
});

test("a snapshot row that froze a NULL target stays null, and does not revert to the live one", () => {
  /*
   * Mutation caught: `frozen === undefined ? live : frozen` -> `frozen ?? live`,
   * which silently reverts a frozen null to the live target and defeats §6.
   *
   * This is reachable in production TODAY, not hypothetically: approveAssessment
   * snapshots all 133 controls, and 4.3.2.6 has a null target — so null snapshot
   * rows already exist. Give that control a target during the re-baseline and the
   * mutation would move an approved assessment's history.
   */
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[4], [2]] },
  ]);
  const r = rollupCe(
    fw,
    assessmentOf({ "4.3.1.1": 2, "4.3.1.2": 2 }, { "4.3.1.1": null, "4.3.1.2": 2 }),
    "4.3.1",
  );
  approx(r.target, 2, "only the control frozen WITH a target counts — not the live 4");
});

test("the half-level threshold is half a level, not a knob", () => {
  // Mutation caught: HALF_LEVEL 0.5 -> 0.6 moved the minor/deficit line by 20%
  // of a level and nothing noticed; the nearest assertion sat 0.1 away.
  assert.equal(healthOf(2.44, 2.95, false), "deficit", "0.51 short is a deficit");
  assert.equal(healthOf(2.45, 2.95, false), "minor", "0.50 short is a Minor Gap");
});
