/**
 * Rollup engine — a faithful port of the KIB workbook's Results sheet.
 * The contract is docs/rollup-spec.md; change that file first, then this one.
 *
 *   actual(CE) = mean(assessor_level over ACTIVE controls that have a score)
 *   target(CE) = the APM published value  (NEVER computed or averaged)
 *   weakest    = the lowest-scoring active control, shown beside the mean
 *
 *   Role Ready        actual >= target
 *   Minor Gap         0 < gap <= 0.5
 *   Capability Deficit gap > 0.5  OR  any single active control >= 2 levels
 *                      below its own target
 */
import type {
  Area, AreaResult, Assessment, CeResult, Control, Framework, Health, Level,
} from "./types";

/** Inactive controls contribute nothing, regardless of any stored score. */
export function activeControlsOf(fw: Framework, ceCode: string): Control[] {
  return fw.controls.filter((c) => c.ce_code === ceCode && c.active);
}

function scoreMap(assessment: Assessment): Map<string, Level | null> {
  const m = new Map<string, Level | null>();
  for (const s of assessment.scores) m.set(s.control_code, s.assessor_level);
  return m;
}

export function healthOf(
  actual: number | null,
  target: Level | null,
  hasSevereControlGap: boolean,
): Health | null {
  if (actual === null || target === null) return null;
  if (hasSevereControlGap) return "deficit";
  const gap = target - actual;
  if (gap <= 0) return "ready";
  if (gap <= 0.5) return "minor";
  return "deficit";
}

export function rollupCe(
  fw: Framework,
  assessment: Assessment,
  ceCode: string,
): CeResult {
  const ce = fw.competence_elements.find((c) => c.code === ceCode);
  const ceTarget = fw.ce_targets.find((t) => t.ce_code === ceCode);
  const controls = activeControlsOf(fw, ceCode);
  const scores = scoreMap(assessment);

  const scored: { code: string; level: Level }[] = [];
  let severe = false;

  for (const c of controls) {
    const lv = scores.get(c.code);
    if (lv === null || lv === undefined) continue;
    scored.push({ code: c.code, level: lv });
    // single-control escalation: 2+ levels below its OWN target
    if (c.target_level !== null && c.target_level - lv >= 2) severe = true;
  }

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

  const target = ceTarget?.target ?? null;
  return {
    ce_code: ceCode,
    ce_name: ce?.name ?? ceTarget?.ce_name ?? ceCode,
    area: ce?.area ?? ceTarget?.area ?? "Practice",
    target,
    actual,
    gap: actual === null || target === null ? null : target - actual,
    health: healthOf(actual, target, severe),
    weakest,
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
