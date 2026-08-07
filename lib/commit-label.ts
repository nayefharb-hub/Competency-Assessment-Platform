/**
 * What the commit button says, and whether the click raises the milestone card.
 *
 * WHY THIS IS ITS OWN MODULE. Six defects have now lived in this one decision —
 * N30 (the same screen promising two different things on two visits), N33 (the
 * milestone that never rose on the walked path), N38 ("Review before submitting"
 * with holes still open), N40 (a hole filled mid-competency reading "Next
 * control"), and two more found by review inside the N38/N40 fix itself. Every
 * one of them was a row in a table nobody could read, because the table was a
 * nested ternary inside a 600-line client component whose other inputs were a
 * live outbox, a router and a race.
 *
 * As a pure function the table can be ENUMERATED. Five booleans and a count is
 * 64 combinations — small enough to check exhaustively rather than sample, which
 * is why there is no pairwise/PICT machinery here: pairwise exists for spaces
 * too large to enumerate, and this one is not. `scripts/commit-label.test.mjs`
 * walks all of them and asserts the properties that the six defects each broke.
 *
 * THE RULE, the owner's (N38/N39/N40): **the button names what the click
 * COMPLETES if it completes something, and otherwise names where it GOES.**
 * Completion is a fact about ANSWERS; position decides only where you go. The
 * two must never share an expression — that shared expression is the defect,
 * four times over.
 *
 * This module decides what the screen SAYS. It never decides what the record
 * holds: `submitSelfAssessment` counts for itself, server-side.
 */

/** Every string the button can carry. A union so a typo cannot compile. */
export type CommitLabel =
  | "Next control"
  | "Finish this competency"
  | "Next unanswered control"
  | "Complete the assessment"
  | "Review this competency"
  | "Review before submitting";

export interface CommitInputs {
  /**
   * Every control in this competency has an answer once this click lands.
   *
   * Decided by the CLIENT, from its own memory plus the outbox plus the server
   * — in that order. The server render is always one answer behind at exactly
   * the moment this matters (D9), so a server-computed version of this field is
   * wrong by construction. See `effectiveLevel` in app/assess/score-panel.tsx.
   */
  ceComplete: boolean;
  /** This control is the positional LAST of its competency. */
  atCeEnd: boolean;
  /**
   * The control already had an answer before this click.
   *
   * The whole difference between "completing" and "re-reading". Without it,
   * re-opening a finished competency claimed to finish it again.
   */
  answeredBefore: boolean;
  /**
   * Controls still unanswered anywhere, counting what the client holds.
   *
   * Can only ever OVERSTATE what is left — the client cannot see answers given
   * on another device — so zero is a fact and non-zero is a maybe. Claiming on
   * zero is therefore the conservative direction.
   */
  assessmentRemaining: number;
  /** There is a next control in framework order. */
  hasNextControl: boolean;
  /** There is a control still owed somewhere, having wrapped past the end. */
  hasNextOwed: boolean;
}

export interface CommitOutcome {
  label: CommitLabel;
  /**
   * The milestone card replaces the panel and the click navigates NOWHERE.
   *
   * Two cases and no others: the click made the competency whole (a hole filled
   * anywhere, which is N40), or the PM reached the competency's end with it
   * already whole — which is where a revision gets shown back to them (N33c).
   * A revision in the MIDDLE of a finished competency is neither, so it moves
   * on; gating this on `ceComplete` alone made walking a finished competency
   * through the primary button impossible.
   */
  raisesCard: boolean;
}

export function decideCommit(input: CommitInputs): CommitOutcome {
  const {
    ceComplete, atCeEnd, answeredBefore,
    assessmentRemaining, hasNextControl, hasNextOwed,
  } = input;

  /* The click is what made the competency whole. The only thing that can
     truthfully be called "completing" — everything else is arriving. */
  const causedIt = ceComplete && !answeredBefore;
  const raisesCard = ceComplete && (atCeEnd || causedIt);
  const nothingLeft = assessmentRemaining === 0;

  if (raisesCard) {
    if (causedIt) {
      return {
        raisesCard,
        label: nothingLeft ? "Complete the assessment" : "Finish this competency",
      };
    }
    /* Nothing was completed — the card is rising because the PM arrived at the
       end of a competency that was already whole. Name what the click DOES: it
       shows the competency back. When there is genuinely nothing left anywhere,
       the more useful thing to name is the next step, and that is the one state
       in which "Review before submitting" is honest. */
    return {
      raisesCard,
      label: nothingLeft ? "Review before submitting" : "Review this competency",
    };
  }

  /* Nothing completed, so the label names the destination. Walking forward, the
     next control is the next control — jumping a PM past controls they answered
     out of order would be the surprise. Only when there is nothing after this
     one does "what do I still owe" take over (N38), which is also the answer to
     "getting back to the skipped ones is cumbersome" (N39). */
  if (hasNextControl) return { raisesCard, label: "Next control" };
  if (hasNextOwed) return { raisesCard, label: "Next unanswered control" };
  return { raisesCard, label: "Review before submitting" };
}
