/**
 * Unit tests for the DEPARTMENT rollup — the PMO-level aggregation behind the
 * analysis screen. Run with `npm run test:unit`.
 *
 * The contract is docs/design-pmo-department-analysis.md + docs/eng-plan-
 * pmo-department-analysis.md. The load-bearing rule is METHOD A: the department
 * number at every level is the mean, over the included people, of THAT PERSON's
 * own rolled-up number — never the roll-up of team-averaged control scores
 * (method B). The two diverge whenever people have different scored-control sets,
 * and telling them apart is the whole reason this file exists (test 1).
 *
 * Written RED before `departmentRollup` existed (ground rule 0): with no export
 * the import is `undefined` and every test throws "not a function". Test 1 stays
 * discriminating after that — on its fixture a method-B implementation returns
 * 3.25 where method A returns 2.5, so the test would be RED against the plausible
 * wrong engine too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { departmentRollup } from "../lib/rollup.ts";

/* ------------------------------------------------------------------ fixtures */
/* Same shape as scripts/rollup.test.mjs — a framework whose controls carry
 * ce_code/active/target_level, and assessments whose scores are assessor_level. */

function frameworkOf(spec) {
  const controls = [];
  const competence_elements = [];
  const ce_targets = [];
  for (const s of spec) {
    let n = 0;
    for (const [target, active = true] of s.controls) {
      n += 1;
      controls.push({
        id: `${s.ce}.${n}-id`, code: `${s.ce}.${n}`, ce_code: s.ce, area: s.area,
        indicator: `indicator ${s.ce}.${n}`, description: null, active,
        priority: "High", reason: null, kib_note: null, apm_competence: null,
        target_level: target, target_label: target === null ? null : String(target),
        target_source: "APM (published)",
      });
    }
    competence_elements.push({
      id: `${s.ce}-id`, code: s.ce, name: s.name ?? `CE ${s.ce}`, area: s.area,
      declared_controls: s.controls.filter(([, a = true]) => a).length,
    });
    ce_targets.push({
      area: s.area, ce_code: s.ce, ce_name: s.name ?? `CE ${s.ce}`,
      active_controls: s.controls.filter(([, a = true]) => a).length, target: s.published,
    });
  }
  return {
    source_file: "test", framework: "IPMA ICB4 v4.0.1",
    scale: { name: "APM", axis: "Application", levels: [] },
    areas: [
      { code: "P1", name: "Perspective" }, { code: "P2", name: "People" },
      { code: "P3", name: "Practice" },
    ],
    competence_elements, controls, measures: [], ce_targets,
  };
}

let personSeq = 0;
/** scores: { "4.3.1.1": 3, ... }; omitted controls are unscored, not zero. */
function personOf(scores, snapshot_targets = undefined, name = `PM ${++personSeq}`) {
  return {
    id: `a-${name}`, assessee_id: `u-${name}`, assessee_name: name,
    assessee_role: "Project Manager", cycle: "2026", profile_id: "p-id",
    state: "approved",
    scores: Object.entries(scores).map(([control_code, assessor_level]) => ({
      control_code, self_level: assessor_level, assessor_level,
      assessor_touched: false, evidence: null,
    })),
    started_at: null, submitted_at: null, approved_at: null, completed_at: null,
    snapshot_targets,
  };
}

const approx = (a, b, msg) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${msg}: expected ~${b}, got ${a}`);
const ceOf = (r, code) => r.ces.find((c) => c.ce_code === code);

/* ---------------------------------------------------- 1. METHOD A, not method B */

/*
 * The whole point. One CE, two active controls (targets 3,3 -> CE target 3).
 *   Person 1 scores both:  4, 4  -> person CE actual 4.0
 *   Person 2 scores one:   1 only -> person CE actual 1.0  (mean over SCORED)
 *
 * METHOD A (correct): mean of per-person actuals = (4.0 + 1.0) / 2 = 2.5
 * METHOD B (wrong):   per-control means then roll up
 *                     control1 = mean(4,1) = 2.5 ; control2 = mean(4) = 4.0
 *                     CE = mean(2.5, 4.0) = 3.25
 * The two diverge because person 2 left control2 unscored. Asserting 2.5 fails
 * against a method-B engine — which is exactly the mistake being guarded.
 */
test("department CE actual is method A (mean of per-person rollups), not method B", () => {
  const fw = frameworkOf([{ ce: "4.3.1", area: "Perspective", published: 3, controls: [[3], [3]] }]);
  const r = departmentRollup(fw, [
    personOf({ "4.3.1.1": 4, "4.3.1.2": 4 }),
    personOf({ "4.3.1.1": 1 }),
  ]);
  approx(ceOf(r, "4.3.1").actual, 2.5, "method A department actual");
  approx(ceOf(r, "4.3.1").target, 3, "department target is the common CE target");
  assert.equal(r.included, 2);
});

/* ------------------------------------------------- 2. frozen snapshot must win */

/*
 * A person approved against a snapshot target that differs from the live one.
 * The department target must reflect the SNAPSHOT (rollup-spec §6), which only
 * holds if departmentData attached snapshot_targets — the listAssessments gap
 * the eng plan calls out. Live control target 2; snapshot says 4; person scores 2.
 */
test("department target honors each person's frozen snapshot, not the live target", () => {
  const fw = frameworkOf([{ ce: "4.5.1", area: "Practice", published: 2, controls: [[2]] }]);
  const r = departmentRollup(fw, [
    personOf({ "4.5.1.1": 2 }, { "4.5.1.1": 4 }),
  ]);
  approx(ceOf(r, "4.5.1").target, 4, "target comes from the snapshot");
  approx(ceOf(r, "4.5.1").actual, 2, "actual is the person's score");
  assert.equal(ceOf(r, "4.5.1").health, "deficit", "2 against a snapshot target of 4 is a deficit");
});

/* ------------------------------------------------------ 3. spread + N below */

test("department competency reports spread and how many are below their own target", () => {
  const fw = frameworkOf([{ ce: "4.4.1", area: "People", published: 3, controls: [[3], [3]] }]);
  const r = departmentRollup(fw, [
    personOf({ "4.4.1.1": 4, "4.4.1.2": 4 }), // 4.0 above
    personOf({ "4.4.1.1": 3, "4.4.1.2": 3 }), // 3.0 ready
    personOf({ "4.4.1.1": 2, "4.4.1.2": 3 }), // 2.5 minor (gap 0.5)
    personOf({ "4.4.1.1": 2, "4.4.1.2": 2 }), // 2.0 deficit (gap 1)
  ]);
  const ce = ceOf(r, "4.4.1");
  assert.deepEqual(ce.spread, { min: 2, max: 4 }, "spread is min-max of per-person actuals");
  assert.equal(ce.below, 2, "the minor and the deficit are below their own target");
  assert.equal(ce.n, 4);
});

/* -------------------------------------------- 4. escalation is a count, not a flag */

/*
 * Two people each 2+ levels below a control's own target, while the department
 * MEAN sits at target. Escalation is a per-person concept: it must surface as a
 * COUNT of people on that control, and must NOT drag the department mean's
 * health to deficit (a department average is not a single control).
 */
test("escalation surfaces as a per-person count and does not deficit the department mean", () => {
  const fw = frameworkOf([{ ce: "4.4.2", area: "People", published: 3, controls: [[3], [3]] }]);
  const r = departmentRollup(fw, [
    personOf({ "4.4.2.1": 1, "4.4.2.2": 5 }), // actual 3.0, control1 escalates (3-1=2)
    personOf({ "4.4.2.1": 1, "4.4.2.2": 5 }), // actual 3.0, control1 escalates
  ]);
  const ce = ceOf(r, "4.4.2");
  approx(ce.actual, 3, "department mean sits at target");
  assert.equal(ce.health, "ready", "the mean is Role Ready — escalation is not applied to it");
  const esc = r.escalations.find((e) => e.control_code === "4.4.2.1");
  assert.ok(esc && esc.count === 2, `control 4.4.2.1 escalates for 2 people: ${JSON.stringify(r.escalations)}`);
});

/* ------------------------------------------------------------- 5. empty set */

test("an empty department (nobody approved / all excluded) yields nulls, not a throw", () => {
  const fw = frameworkOf([{ ce: "4.3.1", area: "Perspective", published: 3, controls: [[3]] }]);
  const r = departmentRollup(fw, []);
  assert.equal(r.included, 0);
  assert.equal(ceOf(r, "4.3.1").actual, null);
  assert.equal(ceOf(r, "4.3.1").spread, null);
  assert.equal(ceOf(r, "4.3.1").below, 0);
  assert.deepEqual(r.perPerson, []);
  assert.deepEqual(r.escalations, []);
});

/* --------------------------------------------- 6. per-person strongest / weakest */

test("per-person summary names the strongest and weakest competency by margin to own target", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, name: "Strategy", controls: [[3]] },
    { ce: "4.4.1", area: "People", published: 3, name: "Teamwork", controls: [[3]] },
  ]);
  const r = departmentRollup(fw, [
    personOf({ "4.3.1.1": 5, "4.4.1.1": 1 }), // Strategy +2 above, Teamwork 2 below
  ]);
  const p = r.perPerson[0];
  assert.equal(p.strongest.ce_code, "4.3.1", "strongest is furthest above its own target");
  approx(p.strongest.margin, 2, "strength margin is actual - target");
  assert.equal(p.weakest.ce_code, "4.4.1", "weakest is furthest below its own target");
  approx(p.weakest.gap, 2, "weakness gap is target - actual");
});

/* ------------------------------ 7. a single scored CE is one thing, not both */

test("a person with one scored competency is not labelled strongest AND weakest", () => {
  const fw = frameworkOf([
    { ce: "4.3.1", area: "Perspective", published: 3, controls: [[3]] },
    { ce: "4.4.1", area: "People", published: 3, controls: [[3]] },
  ]);
  // Only 4.3.1 scored, and it is below target -> a development gap, not a strength.
  const r = departmentRollup(fw, [personOf({ "4.3.1.1": 1 })]);
  const p = r.perPerson[0];
  assert.equal(p.weakest?.ce_code, "4.3.1", "the one below-target CE is the development gap");
  assert.equal(p.strongest, null, "and it is not also reported as the strongest");
});

/* ------------------ 8. method A pairs actual and target over the SAME people */

/*
 * A fully-unscored competency contributes no actual, so it must contribute no
 * target either — otherwise the department target averages over more people than
 * the actual and the gap is not a true per-person figure. With differing snapshot
 * targets the mistake is visible: person A scores 4 against snapshot target 4
 * (on the money); person B has snapshot target 2 but scored NOTHING in the CE.
 * Method A: target = mean over scorers = 4 (B excluded). The wrong version would
 * average targets 4 and 2 -> 3, inventing a gap where the only scorer has none.
 */
test("department target averages over the people who contributed an actual, not all", () => {
  const fw = frameworkOf([{ ce: "4.5.1", area: "Practice", published: 3, controls: [[3]] }]);
  const r = departmentRollup(fw, [
    personOf({ "4.5.1.1": 4 }, { "4.5.1.1": 4 }, "Scorer"),
    personOf({}, { "4.5.1.1": 2 }, "Unscored"),
  ]);
  approx(ceOf(r, "4.5.1").actual, 4, "actual is the only scorer's");
  approx(ceOf(r, "4.5.1").target, 4, "target excludes the unscored person's target");
  approx(ceOf(r, "4.5.1").gap, 0, "no invented gap");
  assert.equal(ceOf(r, "4.5.1").n, 1, "one person contributed");
});
