/**
 * Rollup engine — a faithful port of the KIB workbook's Results sheet.
 * The contract is docs/rollup-spec.md; change that file first, then this one.
 *
 *   actual(CE) = mean(assessor_level over ACTIVE controls that have a score)
 *   target(CE) = mean(target_level over ACTIVE controls that have a target)
 *   weakest    = the lowest-scoring active control, shown beside the mean
 *
 *   Role Ready        actual >= target
 *   Minor Gap         0 < gap <= 0.5
 *   Capability Deficit gap > 0.5  OR  any single active control >= 2 levels
 *                      below its own target
 *
 * The target line CHANGED on 2026-08-08 (owner's decision, for the pilot) and
 * this comment used to read "the APM published value (NEVER computed or
 * averaged)". The reasoning, the evidence that retired the old circularity
 * objection, and the cost that was accepted are all in rollup-spec §3 — read it
 * there rather than re-deriving them. `competence_element.target_level` is
 * retained in the database as the recoverable APM anchor and is no longer read
 * by this engine.
 *
 * BOTH SIDES OF THE GAP ARE NOW MEANS, which is why the half-level threshold
 * carries an epsilon. See healthOf.
 */
import type {
  Area, AreaResult, Assessment, CeResult, Control, Framework, Health, Level,
} from "./types";

/** Inactive controls contribute nothing, regardless of any stored score. */
export function activeControlsOf(fw: Framework, ceCode: string): Control[] {
  return fw.controls.filter((c) => c.ce_code === ceCode && c.active);
}

/**
 * CE target = mean of ACTIVE control targets (rollup-spec §3).
 *
 * Takes EVERY control in the competence element, active or not, and filters
 * `active` itself — so "inactive contributes nothing" is stated once here rather
 * than at each call site. `targetOf` is how the caller says WHICH target: the
 * live framework value, or the one frozen at approval.
 *
 * Two callers, one formula, deliberately:
 *
 *   rollupCe()      -> targetOf = controlTarget(c, snapshot)   snapshot-aware
 *   lib/framework   -> targetOf = c.target_level               the live values
 *
 * A second copy of this mean is exactly how the CE target and the control
 * targets drifted apart in the first place.
 */
export function ceTargetOf(
  controls: Control[],
  targetOf: (c: Control) => Level | null,
): number | null {
  const targets: number[] = [];
  for (const c of controls) {
    if (!c.active) continue;
    const t = targetOf(c);
    // A control with no target is skipped, NOT counted as zero — a missing
    // target is an absence of information, not a bar of Unaware.
    if (t !== null) targets.push(t);
  }
  if (targets.length === 0) return null;
  return targets.reduce((sum, t) => sum + t, 0) / targets.length;
}

function scoreMap(assessment: Assessment): Map<string, Level | null> {
  const m = new Map<string, Level | null>();
  for (const s of assessment.scores) m.set(s.control_code, s.assessor_level);
  return m;
}

/**
 * Half a level, plus a tolerance for the fact that a mean is not a decimal.
 *
 * The threshold in rollup-spec §4 is exactly one half. Since the CE target
 * became a mean too, both sides of the gap are ratios, and a gap that is
 * exactly 1/2 in arithmetic can be a hair over it in IEEE754 — six controls
 * targeting 2,2,2,2,2,4 against scores summing to 11 gives
 * 14/6 - 11/6 === 0.5000000000000002, and a bare `<= 0.5` calls that a
 * Capability Deficit. Enumerated: 972 target/actual combinations across CE
 * sizes 3-8 are affected. Sizes 3 and 5 can never produce an exact half and
 * size 4 divides exactly in binary, so only 6, 7 and 8 are exposed; today's
 * framework has three such competencies and all three are currently clean.
 * That is the only reason this was not already a live defect, and all 133
 * control targets are about to be re-baselined by hand.
 *
 * This is a comparison tolerance, NOT rounding. The gap itself is never
 * rounded — spec §4 requires comparing before rounding, and §7 rounds for
 * display only.
 *
 * DO NOT add the same epsilon to the `gap <= 0` test below. Role Ready is exact
 * and must stay exact: both means are integer sums over integer counts, and
 * IEEE division is correctly rounded, so two mathematically equal means are
 * bit-identical doubles even when their denominators differ (a CE can have more
 * targeted controls than scored ones). Enumerated over every equal-mean pair for
 * counts 1-8 and sums 0-5n: 624 pairs, all giving exactly 0. A tolerance there
 * would hand Role Ready to someone genuinely below target.
 */
const HALF_LEVEL = 0.5 + 1e-9;

export function healthOf(
  actual: number | null,
  target: number | null,
  hasSevereControlGap: boolean,
): Health | null {
  if (actual === null || target === null) return null;
  if (hasSevereControlGap) return "deficit";
  const gap = target - actual;
  if (gap <= 0) return "ready";
  if (gap <= HALF_LEVEL) return "minor";
  return "deficit";
}

/**
 * Per-control targets to judge against. Once an assessment is approved these
 * come from target_snapshot, so a later change to the benchmark profile cannot
 * retrospectively move a historic gap (rollup-spec §6). Before approval they
 * are the framework's live values.
 *
 * REDACTION WARNING, and it is not theoretical for whoever changes this next.
 * `getAssesseeFramework()` nulls every `control.target_level` so a PM cannot see
 * targets while self-scoring — but **the snapshot is not redacted**; it comes
 * from the assessment, not the framework. So on a redacted framework this
 * function still returns real targets for any approved assessment, and since the
 * CE target is now COMPUTED from it, `ce_targets[].target` being nulled no longer
 * protects anything at rollup time.
 *
 * Nothing leaks today: `/results` deliberately uses the FULL framework for
 * everyone and is gated on `state === "approved"` — showing a PM their target is
 * the point of that screen. The anti-anchoring boundary is `/assess`, which never
 * rolls up. But if `/results` is ever switched to `getAssesseeFramework()` as a
 * hardening step, that alone will NOT redact the targets, and the redaction on
 * `ce_targets` will look like it should have.
 */
function controlTarget(
  c: Control,
  snapshot: Record<string, Level | null> | undefined,
): Level | null {
  const frozen = snapshot?.[c.code];
  return frozen === undefined ? c.target_level : frozen;
}

export function rollupCe(
  fw: Framework,
  assessment: Assessment,
  ceCode: string,
): CeResult {
  const ce = fw.competence_elements.find((c) => c.code === ceCode);
  // ce_targets is still the enumeration of competence elements and the source of
  // the display name and area. Its `target` is no longer read here — the target
  // is computed below, because only THIS function knows about the snapshot.
  const ceTarget = fw.ce_targets.find((t) => t.ce_code === ceCode);
  const allControls = fw.controls.filter((c) => c.ce_code === ceCode);
  const controls = activeControlsOf(fw, ceCode);
  const scores = scoreMap(assessment);
  const snapshot =
    assessment.snapshot_targets && Object.keys(assessment.snapshot_targets).length > 0
      ? assessment.snapshot_targets
      : undefined;

  const scored: { code: string; level: Level }[] = [];
  const escalated: CeResult["escalated_by"] = [];

  for (const c of controls) {
    const lv = scores.get(c.code);
    if (lv === null || lv === undefined) continue;
    scored.push({ code: c.code, level: lv });
    // single-control escalation: 2+ levels below its OWN target
    const target = controlTarget(c, snapshot);
    if (target !== null && target - lv >= 2) {
      escalated.push({ control_code: c.code, level: lv, target });
    }
  }
  // Worst shortfall first, ties by control code. The results row names only the
  // first, and "which control forced this" is a question about severity, not
  // alphabetical order — naming a 2-level gap while a 4-level one sits behind it
  // would point the reader at the wrong control.
  escalated.sort(
    (a, b) => (b.target - b.level) - (a.target - a.level) || (a.control_code < b.control_code ? -1 : 1),
  );
  const severe = escalated.length > 0;

  const actual =
    scored.length === 0
      ? null
      : scored.reduce((sum, s) => sum + s.level, 0) / scored.length;

  // weakest active control; ties resolve to the lowest control code
  let weakest: CeResult["weakest"] = null;
  for (const s of scored) {
    if (
      weakest === null ||
      s.level < weakest.level ||
      (s.level === weakest.level && s.code < weakest.control_code)
    ) {
      weakest = { control_code: s.code, level: s.level };
    }
  }

  // Computed here rather than taken from fw.ce_targets, because the snapshot is
  // only visible from inside this function: an approved assessment must be judged
  // against the targets frozen at approval (spec §6), and fw.ce_targets knows
  // nothing about them. Passing allControls, not `controls` — ceTargetOf applies
  // the active rule itself.
  const target = ceTargetOf(allControls, (c) => controlTarget(c, snapshot));
  const health = healthOf(actual, target, severe);
  // Ask the SAME function what the verdict would have been without escalation,
  // rather than re-deriving the thresholds here — the health rule stays in one
  // place (rollup-spec.md §4) and cannot drift between engine and screen.
  const withoutEscalation = healthOf(actual, target, false);

  return {
    ce_code: ceCode,
    ce_name: ce?.name ?? ceTarget?.ce_name ?? ceCode,
    area: ce?.area ?? ceTarget?.area ?? "Practice",
    target,
    actual,
    gap: actual === null || target === null ? null : target - actual,
    health,
    weakest,
    escalated_by: escalated,
    escalation_drove_health: health === "deficit" && withoutEscalation !== "deficit",
    scored_controls: scored.length,
    active_controls: controls.length,
  };
}

export function rollupAll(fw: Framework, assessment: Assessment): CeResult[] {
  return fw.ce_targets.map((t) => rollupCe(fw, assessment, t.ce_code));
}

/** Area tiles: mean of the area's CE actuals vs mean of its CE targets. */
export function rollupAreas(results: CeResult[]): AreaResult[] {
  const order: Area["name"][] = ["Perspective", "People", "Practice"];
  return order.map((area) => {
    const rows = results.filter((r) => r.area === area);
    const withActual = rows.filter((r) => r.actual !== null);
    const withTarget = rows.filter((r) => r.target !== null);
    return {
      area,
      actual:
        withActual.length === 0
          ? null
          : withActual.reduce((s, r) => s + (r.actual as number), 0) / withActual.length,
      target:
        withTarget.length === 0
          ? null
          : withTarget.reduce((s, r) => s + (r.target as number), 0) / withTarget.length,
      ce_count: rows.length,
    };
  });
}

/** Gap-sorted for the results list: biggest gap first, unscored CEs last. */
export function sortByGap(results: CeResult[]): CeResult[] {
  return [...results].sort((a, b) => {
    if (a.gap === null && b.gap === null) return a.ce_code.localeCompare(b.ce_code);
    if (a.gap === null) return 1;
    if (b.gap === null) return -1;
    return b.gap - a.gap;
  });
}

export const HEALTH_LABEL: Record<Health, string> = {
  ready: "Role Ready",
  minor: "Minor Gap",
  deficit: "Capability Deficit",
};

/** Results charts use the 0-5 scale, never percentages. */
export function fmtLevel(n: number | null): string {
  return n === null ? "—" : n.toFixed(1);
}
