"use client";

import { useEffect, useRef, useState } from "react";
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
 * offers Continue as the primary action.
 *
 * THIS CARD ASSERTS NOTHING IT WAS NOT TOLD. Every claim wider than "these
 * controls have answers" arrives as a REMAINING COUNT computed by the panel,
 * which is the only place that knows both the server's persisted counts and the
 * answers still sitting in the outbox. The first cut decided "Every competency
 * scored" from position alone and told a PM who had skipped one control in week
 * one that they had finished, then handed them to a Submit the server refuses.
 * If a count is not zero, the copy does not make the claim.
 *
 * OFFLINE. `goNext` in score-panel refuses to navigate when the browser reports
 * itself offline — D13, measured: router.push falls back to a hard navigation
 * and lands on Chrome's error page, taking the app and its failure banner with
 * it. EVERY action on this card is a navigation, so offline they are all
 * disabled, including "take a break": app/link.tsx already preventDefaults it,
 * so a live-looking link that silently does nothing is worse than one that says
 * so. The card still renders, because the PM genuinely did finish the
 * competency and the outbox genuinely holds their answers.
 */
export default function MilestoneCard({
  milestone,
  levels,
  levelFor,
  currentControl,
  offline,
  busy,
  areaRemaining,
  assessmentRemaining,
  canContinue,
  onContinue,
  onRevise,
}: {
  milestone: Milestone;
  /** The scale, so a recap row can name the level rather than print a number. */
  levels: { level: number; label: string }[];
  /** The PM's answer for a control — server, outbox, or the one on screen. */
  levelFor: (code: string) => number | null;
  /** The control the PM is standing on, so its row can say so. */
  currentControl: string;
  offline: boolean;
  /** A navigation is already in flight; a second click would double the history. */
  busy: boolean;
  /** Controls in THIS AREA still without an answer, counting the outbox. */
  areaRemaining: number;
  /** Controls in the WHOLE ASSESSMENT still without an answer. */
  assessmentRemaining: number;
  /** Whether there is anywhere left to continue TO — the next competency's
   *  first unscored control, or, for a competency finished in the middle of the
   *  run, whatever is still owed. `milestone.nextControl` alone cannot answer
   *  this since N40: it is null for a mid-competency finish. */
  canContinue: boolean;
  onContinue: () => void;
  /** Go back to a control in the competency just finished. */
  onRevise: (code: string) => void;
}) {
  const labelOf = (n: number | null) =>
    n === null ? "not answered" : levels.find((l) => l.level === n)?.label ?? String(n);

  /* FOCUS, NOT A LIVE REGION.
   *
   * The button the PM just pressed is unmounted by the swap, so focus falls to
   * <body> and their next Tab restarts at the top of the document — 28 times
   * per assessment. An aria-live wrapper cannot cover for that: assistive tech
   * announces mutations INSIDE a region that already existed, and this one is
   * inserted already-populated, so the announcement is unreliable in every
   * major screen reader. Moving focus to the heading announces it, scrolls the
   * card into view (which matters below 1100px, where the card renders under a
   * prose card that can run to 2,596 characters), and puts Tab at the top of
   * the thing that just appeared. One mechanism, three problems.
   */
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  /* Enter continues, the same key that confirmed every answer on the way here.
   *
   * ARMED ONLY AFTER A KEYUP. Without this, holding Enter a beat too long on
   * the last control of a competency defeats the whole feature: the panel's
   * handler flushes `setReached(true)` synchronously, this effect registers
   * before the OS delivers the auto-repeat ~33ms later, and the card mounts and
   * navigates within a frame. The milestone flashes and is gone — and it would
   * happen to exactly the PM the keyboard support was built for, the one 90
   * controls into a sitting who is in a rhythm. `e.repeat` alone is not enough,
   * because the repeat that lands first is the one that started on the panel.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const onUp = (e: KeyboardEvent) => { if (e.key === "Enter") setArmed(true); };
    document.addEventListener("keyup", onUp);
    return () => document.removeEventListener("keyup", onUp);
  }, []);

  useEffect(() => {
    if (offline || busy || !armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing = el && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName);
      if (e.key === "Enter" && !typing && !el?.isContentEditable && canContinue) {
        e.preventDefault();
        onContinue();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [offline, busy, armed, canContinue, onContinue]);

  /* THE COUNTS DECIDE, NOT THE POSITION (N38/N40).
   *
   * This used to require `done === "assessment"` as well as a zero remaining
   * count — position AND truth. That was the safe direction when the card only
   * ever rose at a competency's last control, and it becomes wrong the moment
   * the card can rise wherever a competency is finished: a PM whose final
   * unanswered control sits in the middle of the framework really has finished
   * everything, and the card would have refused to say so because they were not
   * standing in the right place.
   *
   * The counts can only ever UNDERSTATE — the client cannot see answers made on
   * another device — so a zero is a fact and a non-zero is a maybe. Claiming on
   * zero is therefore still the conservative direction. */
  const finishedEverything = assessmentRemaining === 0;
  const areaFinished = !finishedEverything && areaRemaining === 0;

  return (
    <div className="card pad milestone">
      <p className="milestone-tick" aria-hidden="true">✓</p>

      <h2 className="milestone-title" ref={heading} tabIndex={-1}>
        {finishedEverything ? "Every competency scored" : `${milestone.ce.name} complete`}
      </h2>
      <p className="note milestone-sub">
        {finishedEverything
          ? <>That is all <b className="tnum">{milestone.assessment.total}</b> controls.
              The next step is to review and submit.</>
          : <>
              All <b className="tnum">{milestone.ce.total}</b> controls answered
              {areaFinished && <> · {milestone.area.name} finished</>}
              {assessmentRemaining > 0 && !milestone.nextControl && (
                /* Positionally the end, but not actually finished. Saying so here
                   is the difference between a tool that supports a decision and
                   one that congratulates you into a refused Submit.

                   GATED ON `nextControl`, NOT ON `canContinue`. They were the
                   same test until N38 gave the card somewhere to continue TO
                   when the run has holes behind it — and that silently deleted
                   this sentence on the one screen it was written for, the last
                   control of the framework. `nextControl` is the honest test:
                   it is null exactly when there is no competency ahead, which
                   is when a PM could believe they had finished. Mid-run it is
                   set, so this does not become "127 controls elsewhere" on
                   every one of the 28 milestones. */
                <> · <b className="tnum">{assessmentRemaining}</b>
                  {assessmentRemaining === 1 ? " control" : " controls"} elsewhere
                  still need a score</>
              )}
            </>}
      </p>

      {/* The recap. A milestone that only congratulates is a speed bump; one
          that shows the work back is a checkpoint, and this is the last easy
          moment to change an answer before moving on. */}
      <ul className="milestone-recap">
        {milestone.controls.map((c) => (
          <li key={c.code}>
            <button
              type="button"
              className="milestone-revise"
              onClick={() => onRevise(c.code)}
              disabled={offline}
              title={c.indicator ?? c.code}
            >
              <span className="milestone-code tnum">{c.code}</span>
              <span className="milestone-indicator">{c.indicator ?? c.code}</span>
              <span className="milestone-level">
                {labelOf(levelFor(c.code))}
                {c.code === currentControl && <span className="milestone-just"> · just now</span>}
              </span>
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
          connection returns — carrying on has to wait until it does.
        </p>
      )}

      <div className="assess-actions">
        {canContinue && (
          <button
            className="btn btn-primary"
            type="button"
            onClick={onContinue}
            disabled={offline || busy}
          >
            Continue →
          </button>
        )}
        {offline ? (
          <button className="btn btn-secondary" type="button" disabled>
            {finishedEverything ? "Review and submit →" : "Take a break"}
          </button>
        ) : (
          <Link className="btn btn-secondary" href={milestone.listHref}>
            {finishedEverything ? "Review and submit →" : "Take a break"}
          </Link>
        )}
      </div>
    </div>
  );
}
