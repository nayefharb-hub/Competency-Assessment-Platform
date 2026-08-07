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
 * What sits at the end of a competency — the facts, not the verdict.
 *
 * WHY THERE IS NO `complete` FIELD HERE, which is the whole point of the
 * rewrite. This function runs on the server, from PERSISTED scores. The answer
 * the PM is looking at has not been committed yet when the label is chosen, so
 * a `complete` computed here is always one answer behind at exactly the moment
 * it matters — the last control of a competency. That was N30: the same screen
 * said "Back to the list" on the visit where the fifth answer was still
 * uncommitted, and "Finish this competency" on a later visit.
 *
 * So the server reports `scored` and `total` and the CLIENT adds the pending
 * answer, because the client is the only place that knows about it. See
 * `ceComplete` in app/assess/score-panel.tsx.
 *
 * This does NOT relax the submit precondition. `submitSelfAssessment` still
 * refuses an incomplete assessment from its own count, which is what protects
 * against the case the old comment here recorded: a PM who skipped four of five
 * controls, scored the last one, and was told "Finish this competency".
 */
export interface Milestone {
  /** The competency that just ended. `scored` counts PERSISTED answers only. */
  ce: { code: string; name: string; scored: number; total: number };
  /** Every control in it, in order — the recap the milestone card shows. */
  controls: { code: string; indicator: string | null }[];
  /** Where Continue goes: the next competency's first UNANSWERED control. */
  nextControl: string | null;
  /** What the PM is about to start, for the "next up" line. */
  nextCe: { code: string; name: string } | null;
  /**
   * Which boundary this is POSITIONALLY — a competency, an area, the end, or
   * `"mid"` for a control that ends nothing by position.
   *
   * `"mid"` exists because completion stopped being a positional question
   * (N38/N40): a control in the middle of a competency can still be the answer
   * that finishes it. `done` remains strictly about POSITION — it is the card's
   * business to know whether crossing this control also crosses an area — and
   * whether the competency is FINISHED is decided by the client from answers.
   */
  done: "ce" | "area" | "assessment" | "mid";
  /**
   * COUNTS, NOT VERDICTS, at the two wider scopes — for the same reason `ce` is
   * a count. `done` is POSITIONAL: it says the PM stood on the last control of
   * the last competency of an area, not that the area is finished.
   *
   * The first cut of N32 set `areaDone: area.name` unconditionally and rendered
   * "· Perspective finished", and decided "Every competency scored" from
   * `done === "assessment"` alone. The guard that had prevented exactly that
   * (`area.scored === area.controls`) existed before N32 and was deleted rather
   * than moved, so a PM who skipped one control in week one and then worked
   * through the other 131 in order was told the assessment was finished and
   * sent to a Submit the server refuses. Found by the review pass on this PR.
   *
   * These are PERSISTED counts. The client adds the answers it holds that the
   * server has not seen, which can only ever understate: unseen answers outside
   * this competency make the card say "Strategy complete" where it could have
   * said more. Understating is a quieter card; overstating is a lie.
   */
  area: { name: string; scored: number; total: number };
  assessment: { scored: number; total: number };
  /** Where "take a break" goes. Also the fallback if Continue cannot run. */
  listHref: string;
}

/**
 * The competency the PM is standing in — ALWAYS, wherever they are standing in
 * it (N38/N40).
 *
 * WHY THIS EXISTS BESIDE `nextAfter`. `nextAfter` answers a POSITIONAL question:
 * "is this the last control of its competency, and what boundary is that?" It
 * returns null for the other 104 controls, which was right for the milestone and
 * wrong for the button. The owner walked the assessment and found both halves of
 * the same defect: at control 132 with holes still open the button read "Review
 * before submitting" (there is no next control, so the label fell through to the
 * end-of-assessment wording), and a skipped control filled mid-competency read
 * "Next control" even when that answer completed the competency.
 *
 * The rule that came out of it: **the button names what the click COMPLETES if
 * it completes something, and otherwise names where it GOES.** Completion is a
 * fact about answers, not about position, so the panel needs the competency's
 * controls at every control — not only at its last one.
 *
 * COUNTS, NEVER VERDICTS — the same contract `nextAfter` already carries and for
 * the same reason. This reports which controls the competency contains and what
 * the server has persisted; the client adds what it holds and decides. Deciding
 * here would be deciding from a render that is always one answer behind.
 *
 * COSTS NOTHING EXTRA. Everything is derived from `areas`, which `shapeOf`
 * already built in memory from data the page had fetched. No round trip moves.
 */
export function ceContextAt(
  areas: AreaShape[],
  control: Control,
): Milestone | null {
  const area = areas.find((a) => a.name === control.area);
  const ce = area?.ces.find((c) => c.code === control.ce_code);
  if (!area || !ce) return null;

  const positional = nextAfter(areas, control);
  if (positional) return positional;

  /* Mid-competency. The competency is the same; what differs is that finishing
     it here is not also crossing an area or the end of the framework, so `done`
     says so and the wider scopes still report their counts. */
  return {
    ce: { code: ce.code, name: ce.name, scored: ce.scored, total: ce.controls.length },
    controls: ce.controls.map((c) => ({ code: c.code, indicator: c.indicator })),
    nextControl: null,
    nextCe: null,
    done: "mid",
    area: { name: area.name, scored: area.scored, total: area.controls },
    assessment: {
      scored: areas.reduce((n, a) => n + a.scored, 0),
      total: areas.reduce((n, a) => n + a.controls, 0),
    },
    listHref: `/assess/area/${encodeURIComponent(area.name)}`,
  };
}

/**
 * The next control the PM still OWES, in framework order, wrapping past the end.
 *
 * Not "the next control" — that is `neighbours()`, and it is the right answer
 * while walking forward. This is the answer to "where do I go now that I have
 * finished something", which is what Continue asks, and after a PM has skipped
 * around it is not the same place.
 *
 * RETURNS SEVERAL, and the client picks. The server's list is one answer behind
 * by construction (D9), so the first entry may be the control the PM is standing
 * on — the one they are answering right now — or one they answered seconds ago
 * that has not landed. The client knows both and skips them. Five is far more
 * than the outbox can plausibly hold at once and costs five short strings.
 */
export function owedAfter(
  areas: AreaShape[],
  scored: Set<string>,
  from: Control,
  limit = 5,
): string[] {
  const ordered = areas.flatMap((a) => a.ces.flatMap((c) => c.controls));
  const at = ordered.findIndex((c) => c.code === from.code);
  const wrapped = at < 0 ? ordered : [...ordered.slice(at + 1), ...ordered.slice(0, at + 1)];
  return wrapped.filter((c) => !scored.has(c.code)).slice(0, limit).map((c) => c.code);
}

/**
 * Where the PM is at the end of a control, given the shape (D25, revised).
 *
 * A competence element is still the sitting and finishing it is still a moment
 * — but the moment now happens IN PLACE rather than as a route change, so the
 * PM is not ejected from the flow 28 times per assessment (N32). This returns
 * the facts that milestone needs; the card decides how to present them.
 */
export function nextAfter(
  areas: AreaShape[],
  control: Control,
): Milestone | null {
  const area = areas.find((a) => a.name === control.area);
  const ce = area?.ces.find((c) => c.code === control.ce_code);
  if (!area || !ce) return null;

  const isLastInCe = ce.controls[ce.controls.length - 1]?.code === control.code;
  if (!isLastInCe) return null;                       // ordinary next control

  const ceIndex = area.ces.indexOf(ce);
  const areaIndex = areas.indexOf(area);
  const isLastInArea = ceIndex === area.ces.length - 1;
  const nextArea = areas[areaIndex + 1];

  /* The next competency in FRAMEWORK order, crossing into the next area when
     this one is finished. */
  const nextCe = !isLastInArea ? area.ces[ceIndex + 1] : (nextArea?.ces[0] ?? null);

  /* CONTINUE MEANS "THE NEXT THING YOU OWE ME", not "the next control in
     order". Every other resume path in the app lands on `firstUnscored`
     (app/assess/page.tsx, and the hub), and the assessment header explicitly
     invites jumping around — "you can jump back to any control" — so a PM who
     took that invitation would otherwise press Continue and land on a
     pre-filled panel with no explanation. Falls back to the first control when
     the next competency is already finished, which is the only sensible place
     left to stand. */
  const base = {
    ce: { code: ce.code, name: ce.name, scored: ce.scored, total: ce.controls.length },
    controls: ce.controls.map((c) => ({ code: c.code, indicator: c.indicator })),
    nextControl: (nextCe?.firstUnscored ?? nextCe?.controls[0])?.code ?? null,
    nextCe: nextCe ? { code: nextCe.code, name: nextCe.name } : null,
    area: { name: area.name, scored: area.scored, total: area.controls },
    assessment: {
      scored: areas.reduce((n, a) => n + a.scored, 0),
      total: areas.reduce((n, a) => n + a.controls, 0),
    },
  };

  if (!isLastInArea) {
    return { ...base, done: "ce", listHref: `/assess/area/${encodeURIComponent(area.name)}` };
  }
  if (nextArea) {
    return { ...base, done: "area", listHref: ASSESS_HUB };
  }
  // ?saved=1 raises the save confirmation on the controls list. The last answer
  // of the assessment must not land silently, right before Submit.
  return {
    ...base,
    done: "assessment",
    nextControl: null,
    nextCe: null,
    listHref: "/assess/controls?saved=1",
  };
}
