"use client";

import { useEffect } from "react";
import Link from "@/app/link";
import type { Milestone } from "@/lib/shape";

/**
 * The moment a competency is finished — in place, not as a route change.
 *
 * D25 decided that a competence element is the sitting and that finishing it is
 * a moment worth marking. It was right. What it got wrong was the mechanism: the
 * moment was built as a navigation to a list, so the PM was ejected from the
 * flow and made to find their next competency. With 28 competencies and a median
 * of five controls each, that is 28 forced navigations per assessment — one
 * every five answers (N32).
 *
 * So the milestone still happens; it just does not cost a page. This card swaps
 * into the panel's place, says what was finished, shows the answers back, and
 * offers Continue as the primary action. Taking a break stays one click away,
 * because a sitting nobody can leave is worse than one nobody can continue.
 *
 * OFFLINE (review decision A1). `goNext` in score-panel refuses to navigate when
 * the browser reports itself offline — D13, measured: router.push falls back to
 * a hard navigation and lands on Chrome's error page, taking the app and its
 * failure banner with it. Continue IS a navigation, so offline it would be a
 * dead button. The card still renders, because the PM genuinely did finish the
 * competency and the outbox genuinely holds their answers — hiding it would be
 * less honest, not more. Continue is disabled and says why; the break link stays
 * live, because leaving costs nothing.
 */
export default function MilestoneCard({
  milestone,
  levels,
  levelFor,
  offline,
  onContinue,
  onRevise,
}: {
  milestone: Milestone;
  /** The scale, so a recap row can name the level rather than print a number. */
  levels: { level: number; label: string }[];
  /** The PM's answer for a control, including the one just given. */
  levelFor: (code: string) => number | null;
  offline: boolean;
  onContinue: () => void;
  /** Go back to a control in the competency just finished. */
  onRevise: (code: string) => void;
}) {
  const labelOf = (n: number | null) =>
    n === null ? "not answered" : levels.find((l) => l.level === n)?.label ?? String(n);

  /* Enter continues, the same key that confirmed every answer on the way here.
     Ignored while the browser is offline, where Continue does nothing, and
     while focus is in a control so Space/Enter on a button still means that
     button. */
  useEffect(() => {
    if (offline) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName);
      if (e.key === "Enter" && !typing && milestone.nextControl) {
        e.preventDefault();
        onContinue();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [offline, milestone.nextControl, onContinue]);

  const finishedEverything = milestone.done === "assessment";

  return (
    <div className="card pad milestone" role="status" aria-live="polite">
      <p className="milestone-tick" aria-hidden="true">✓</p>

      <h2 className="milestone-title">
        {finishedEverything ? "Every competency scored" : `${milestone.ce.name} complete`}
      </h2>
      <p className="note milestone-sub">
        {finishedEverything
          ? "That is all 132 controls. The next step is to review and submit."
          : <>
              <b className="tnum">{milestone.ce.total}</b> of{" "}
              <b className="tnum">{milestone.ce.total}</b> controls answered
              {milestone.areaDone && <> · {milestone.areaDone} finished</>}
            </>}
      </p>

      {/* The recap. A milestone that only congratulates is a speed bump; one
          that shows the work back is a checkpoint, and this is the last easy
          moment to change an answer before moving on. */}
      <ul className="milestone-recap">
        {milestone.controls.map((c) => (
          <li key={c.code}>
            <button type="button" className="milestone-revise" onClick={() => onRevise(c.code)}>
              <span className="milestone-code tnum">{c.code}</span>
              <span className="milestone-indicator">{c.indicator ?? c.code}</span>
              <span className="milestone-level">{labelOf(levelFor(c.code))}</span>
            </button>
          </li>
        ))}
      </ul>

      {milestone.nextCe && (
        <p className="note milestone-next">
          Next: <b>{milestone.nextCe.code} {milestone.nextCe.name}</b>
        </p>
      )}

      {offline && (
        <p className="note milestone-offline" role="status">
          You are offline. Your answers are saved and will send when the
          connection returns — you can carry on once it does.
        </p>
      )}

      <div className="assess-actions">
        {milestone.nextControl && (
          <button
            className="btn btn-primary"
            type="button"
            onClick={onContinue}
            disabled={offline}
          >
            Continue →
          </button>
        )}
        <Link className="btn btn-secondary" href={milestone.listHref}>
          {finishedEverything ? "Review and submit →" : "Take a break"}
        </Link>
      </div>
    </div>
  );
}
