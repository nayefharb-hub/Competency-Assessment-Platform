import type { Control, Measure, Score } from "./types.ts";
import { estimateMinutes, measureIndex, type Estimate } from "./duration.ts";
import { ASSESS_HUB } from "./routes.ts";

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
 * Has this PM answered everything they are being asked to answer?
 *
 * Extracted because the hub and the control list were computing it separately,
 * and a review found the hub's copy carrying a comment asserting they "cannot
 * disagree". They agreed by coincidence, not by construction. That is the same
 * defect this change set exists to remove from navigation, so it should not be
 * reintroduced one file over.
 *
 * THE SERVER'S SUBMIT PRECONDITION IS DELIBERATELY NOT A THIRD CALLER.
 * `submitSelfAssessment` works from `control_id` (it has the score rows, not
 * the framework), while this works from `code`. Two of three share the seam;
 * the third would need a key extractor to join them, and pretending otherwise
 * in this comment is how the last "cannot disagree" claim got written.
 *
 * ACTIVE CONTROLS ONLY. ICB4 ships 133 controls and one is inactive; an
 * inactive control contributes nothing to any rollup and must never be able to
 * hold an assessment open.
 *
 * AN EMPTY FRAMEWORK IS NOT A FINISHED ASSESSMENT. `[].every()` is `true`, so
 * without the length guard a framework fetch that came back empty would put
 * "Review and submit" in front of a PM who has answered nothing — the hub
 * offering to hand a zero-control assessment to the Head of PMO. Caught by a
 * /review pass reading the boundary rather than the happy path.
 */
export function isComplete(active: Control[], scored: Set<string>): boolean {
  return active.length > 0 && active.every((c) => scored.has(c.code));
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
  ceOf: (ceCode: string) => { code: string; name: string } | undefined,
  measures: Measure[],
  scored: Set<string>,
  /** Authoritative area order (framework sort_order). Falls back to the order
   *  controls happen to arrive in, which is only accidentally the same. */
  areaOrder?: string[],
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
      // ceOf is keyed by COMPETENCE ELEMENT code ("4.3.1"), not control code
      // ("4.3.1.1"). Passing the control code returned undefined every time,
      // so every row rendered "4.3.1 4.3.1" instead of "4.3.1 Strategy".
      const meta = ceOf(control.ce_code);
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

  const index = measureIndex(measures);
  for (const area of areas) {
    for (const ce of area.ces) ce.estimate = estimateMinutes(ce.controls, index);
    area.estimate = estimateMinutes(area.ces.flatMap((c) => c.controls), index);
  }

  // Framework order, not encounter order. They agree today; they stop agreeing
  // the moment an admin edits one control's sort_order, and the divergence
  // would be invisible.
  if (areaOrder) {
    areas.sort((a, b) => areaOrder.indexOf(a.name) - areaOrder.indexOf(b.name));
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
): { href: string; done: "ce" | "area" | "assessment"; complete: boolean; label: string } | null {
  const area = areas.find((a) => a.name === control.area);
  const ce = area?.ces.find((c) => c.code === control.ce_code);
  if (!area || !ce) return null;

  const isLastInCe = ce.controls[ce.controls.length - 1]?.code === control.code;
  if (!isLastInCe) return null;                       // ordinary next control

  // "Complete" has to be true. Positional was not enough: a PM who skipped
  // four of five controls and scored the last one was told "Finish this
  // competency" and shown 1/5, and at the end of the assessment was pointed
  // at a Submit the server would refuse.
  const ceComplete = ce.scored === ce.controls.length;

  const ceIndex = area.ces.indexOf(ce);
  const isLastInArea = ceIndex === area.ces.length - 1;

  if (!isLastInArea) {
    return {
      href: `/assess/area/${encodeURIComponent(area.name)}`,
      done: "ce",
      complete: ceComplete,
      label: ceComplete
        ? `${ce.name} complete — next: ${area.ces[ceIndex + 1].name}`
        : `${ce.name} — ${ce.scored} of ${ce.controls.length} scored`,
    };
  }

  const areaIndex = areas.indexOf(area);
  const nextArea = areas[areaIndex + 1];
  const areaComplete = area.scored === area.controls;
  if (nextArea) {
    return {
      href: ASSESS_HUB, done: "area", complete: areaComplete,
      label: areaComplete
        ? `${area.name} complete — next: ${nextArea.name}`
        : `${area.name} — ${area.scored} of ${area.controls} scored`,
    };
  }
  // ?saved=1 is what raises the save confirmation on the controls list. The
  // boundary branch pre-empts the panel's fallback, so it has to carry it —
  // otherwise the 132nd answer lands silently, right before Submit.
  return {
    href: "/assess/controls?saved=1", done: "assessment",
    complete: areaComplete, label: "Every competency scored",
  };
}
