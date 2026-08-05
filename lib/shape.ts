import type { Control, Measure, Score } from "./types.ts";
import { estimateMinutes, type Estimate } from "./duration.ts";

/**
 * The shape of the work: areas → competence elements → controls.
 *
 * WHY THIS EXISTS (docs/design-assessment-flow-and-pace.md). 132 controls is
 * not a long form, it is a project with no work-breakdown — which is why there
 * was no sense of progress across sessions, no way to see a stall, and nowhere
 * to jump to. The framework already contained the missing unit: 28 competence
 * elements of 3-6 controls each, which is a sitting a person can decide to do.
 *
 * Everything here is derived in memory from data the caller already fetched —
 * the framework is memoized and `findAssessmentWithScores` returns every score
 * in one request. No round trips are added to the assessment path, which is
 * the path two PRs were spent making fast.
 */

export interface CeShape {
  code: string;
  name: string;
  controls: Control[];
  scored: number;
  /** First control with no self_level — where "continue" should land. */
  firstUnscored?: Control;
  estimate: Estimate;
}

export interface AreaShape {
  name: string;
  ces: CeShape[];
  controls: number;
  scored: number;
  estimate: Estimate;
  firstUnscored?: Control;
}

/** Controls whose self_level is set, as a set of codes. */
export function scoredCodes(scores: Score[]): Set<string> {
  return new Set(scores.filter((s) => s.self_level !== null).map((s) => s.control_code));
}

/**
 * Group the active controls by area and competence element, with progress and
 * a duration on each level.
 *
 * Order comes from the framework's own arrays, which are already sorted by
 * `sort_order` — the ICB4 sequence, not alphabetical, because 4.3.1 Strategy
 * before 4.3.2 Governance is the standard's own ordering and PMs will have
 * seen it in the workbook.
 */
export function shapeOf(
  activeControls: Control[],
  ceOf: (code: string) => { code: string; name: string } | undefined,
  measures: Measure[],
  scored: Set<string>,
): AreaShape[] {
  const areas: AreaShape[] = [];
  const areaByName = new Map<string, AreaShape>();
  const ceByCode = new Map<string, CeShape>();

  for (const control of activeControls) {
    let area = areaByName.get(control.area);
    if (!area) {
      area = { name: control.area, ces: [], controls: 0, scored: 0, estimate: { low: 0, high: 0 } };
      areaByName.set(control.area, area);
      areas.push(area);
    }

    const ceKey = `${control.area}/${control.ce_code}`;
    let ce = ceByCode.get(ceKey);
    if (!ce) {
      const meta = ceOf(control.code);
      ce = {
        code: control.ce_code,
        name: meta?.name ?? control.ce_code,
        controls: [],
        scored: 0,
        estimate: { low: 0, high: 0 },
      };
      ceByCode.set(ceKey, ce);
      area.ces.push(ce);
    }

    ce.controls.push(control);
    area.controls += 1;
    if (scored.has(control.code)) {
      ce.scored += 1;
      area.scored += 1;
    } else {
      ce.firstUnscored ??= control;
      area.firstUnscored ??= control;
    }
  }

  for (const area of areas) {
    for (const ce of area.ces) ce.estimate = estimateMinutes(ce.controls, measures);
    area.estimate = estimateMinutes(area.ces.flatMap((c) => c.controls), measures);
  }
  return areas;
}

/**
 * Where "Next" goes at the end of a control, given the shape (D25).
 *
 * A competence element is the sitting, so its last control does NOT walk into
 * the next CE's first — finishing is a moment, and continuing is a choice. The
 * last CE of an area steps up one further, to the area screen.
 */
export function nextAfter(
  areas: AreaShape[],
  control: Control,
): { href: string; done: "ce" | "area" | "assessment"; label: string } | null {
  const area = areas.find((a) => a.name === control.area);
  const ce = area?.ces.find((c) => c.code === control.ce_code);
  if (!area || !ce) return null;

  const isLastInCe = ce.controls[ce.controls.length - 1]?.code === control.code;
  if (!isLastInCe) return null;                       // ordinary next control

  const ceIndex = area.ces.indexOf(ce);
  const isLastInArea = ceIndex === area.ces.length - 1;

  if (!isLastInArea) {
    return {
      href: `/assess/area/${encodeURIComponent(area.name)}`,
      done: "ce",
      label: `${ce.name} complete — next: ${area.ces[ceIndex + 1].name}`,
    };
  }

  const areaIndex = areas.indexOf(area);
  const nextArea = areas[areaIndex + 1];
  if (nextArea) {
    return { href: "/assess/areas", done: "area", label: `${area.name} complete — next: ${nextArea.name}` };
  }
  return { href: "/assess/controls", done: "assessment", label: "Every competency scored" };
}
