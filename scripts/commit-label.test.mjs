/**
 * The commit decision, enumerated.
 *
 * Six defects have lived in this one table — N30, N33, N38, N40, and two found
 * by review inside the N38/N40 fix. Each was a single row reading wrong, and
 * each was found by a person noticing rather than by a test failing, because
 * the table was a nested ternary inside a client component wired to an outbox,
 * a router and a race.
 *
 * As a pure function the whole space is 2^5 x 2 = 64 rows. That is small enough
 * to ENUMERATE, so there is no pairwise sampling here: pairwise exists for
 * spaces too large to walk, and exhaustive is strictly stronger when you can
 * afford it. Runs in milliseconds, no browser, no database.
 *
 * THE TESTS THAT MATTER ARE THE PROPERTIES, not the row-by-row expectations. A
 * hand-written 64-row expected table is just the implementation retyped, and it
 * agrees with the bug as readily as with the fix — which is exactly how the
 * milestone tests were green against a build where the feature did not work.
 * So most of what follows states things that must be true of EVERY row, and
 * only the handful of rows a PM actually meets are pinned by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideCommit } from "../lib/commit-label.ts";

const BOOLS = [false, true];
/** Every input combination. `assessmentRemaining` matters only as zero/non-zero. */
const ALL = [];
for (const ceComplete of BOOLS)
  for (const atCeEnd of BOOLS)
    for (const answeredBefore of BOOLS)
      for (const hasNextControl of BOOLS)
        for (const hasNextOwed of BOOLS)
          for (const assessmentRemaining of [0, 7])
            ALL.push({
              ceComplete, atCeEnd, answeredBefore,
              hasNextControl, hasNextOwed, assessmentRemaining,
            });

const EVERY_LABEL = [
  "Next control",
  "Finish this competency",
  "Next unanswered control",
  "Complete the assessment",
  "Review this competency",
  "Review before submitting",
];

/** Says a completion happened. These are the only labels that may make a claim. */
const CLAIMS_COMPLETION = new Set(["Finish this competency", "Complete the assessment"]);
/** Names a place to go rather than something that happened. */
const NAMES_A_DESTINATION = new Set(["Next control", "Next unanswered control"]);

const show = (d) => JSON.stringify(d);

test("every combination returns a known label and a boolean, none throw", () => {
  for (const d of ALL) {
    const out = decideCommit(d);
    assert.ok(EVERY_LABEL.includes(out.label), `unknown label for ${show(d)}: ${out.label}`);
    assert.equal(typeof out.raisesCard, "boolean", show(d));
  }
  assert.equal(ALL.length, 64, "the space is 64 rows — if this changed, so did the inputs");
});

/* --- The properties the six defects each broke ------------------------------ */

test("a label may only claim a completion when this click caused one", () => {
  /* N40's first cut, and the review finding on the second: "Complete the
     assessment" appeared when re-opening the last control of an assessment that
     had been finished for a week. A claim about an event needs the event. */
  for (const d of ALL) {
    const { label } = decideCommit(d);
    if (!CLAIMS_COMPLETION.has(label)) continue;
    assert.ok(d.ceComplete && !d.answeredBefore,
      `"${label}" claims a completion that did not happen: ${show(d)}`);
  }
});

test("the assessment is only claimed complete when nothing is left", () => {
  for (const d of ALL) {
    const { label } = decideCommit(d);
    if (label !== "Complete the assessment") continue;
    assert.equal(d.assessmentRemaining, 0, show(d));
  }
});

test("the card rises exactly when the competency's completion is this click's news", () => {
  /* Both halves are load-bearing and each was wrong once. Gating on `ceComplete`
     alone trapped a PM re-reading a finished competency (they got the card
     instead of moving on, on every control). Gating on position alone was N40 —
     a hole filled mid-competency finished it and nothing happened. */
  for (const d of ALL) {
    const { raisesCard } = decideCommit(d);
    const causedIt = d.ceComplete && !d.answeredBefore;
    assert.equal(raisesCard, d.ceComplete && (d.atCeEnd || causedIt), show(d));
  }
});

test("when the click navigates, the label names where it is going", () => {
  /* N38: at control 132 with holes still open the label fell through to "Review
     before submitting" — the PM had run out of controls to WALK PAST, which is
     not the same as having answered them, and the Submit behind it was refused
     by the server. If there is somewhere to go, say so. */
  for (const d of ALL) {
    const { label, raisesCard } = decideCommit(d);
    if (raisesCard) continue;
    if (d.hasNextControl || d.hasNextOwed) {
      assert.ok(NAMES_A_DESTINATION.has(label),
        `there is somewhere to go but the label is "${label}": ${show(d)}`);
    } else {
      assert.equal(label, "Review before submitting", show(d));
    }
  }
});

test("a click that navigates never claims to complete anything", () => {
  for (const d of ALL) {
    const { label, raisesCard } = decideCommit(d);
    if (raisesCard) continue;
    assert.ok(!CLAIMS_COMPLETION.has(label),
      `"${label}" on a click that only moves: ${show(d)}`);
  }
});

test("walking forward beats mopping up — the next control wins when there is one", () => {
  for (const d of ALL) {
    const { label, raisesCard } = decideCommit(d);
    if (raisesCard || !d.hasNextControl) continue;
    assert.equal(label, "Next control",
      `jumping the PM past a control they are walking towards: ${show(d)}`);
  }
});

test("no dead label — every wording the button can carry is reachable", () => {
  /* This is the one that finds wording nobody can ever see. Review found by
     hand that "Review before submitting" had become unreachable through the
     ordinary fall-through; a dead branch is either a missing state or a lie
     waiting for a refactor to expose. Now it fails on its own. */
  const produced = new Set(ALL.map((d) => decideCommit(d).label));
  const dead = EVERY_LABEL.filter((l) => !produced.has(l));
  assert.deepEqual(dead, [], `unreachable label(s): ${dead.join(", ")}`);
});

test("the decision is total and stable — same input, same answer", () => {
  for (const d of ALL) {
    assert.deepEqual(decideCommit({ ...d }), decideCommit({ ...d }), show(d));
  }
});

/* --- The rows a PM actually meets, pinned by name --------------------------- */

const scenario = (name, input, label, raisesCard) => test(name, () => {
  const out = decideCommit(input);
  assert.equal(out.label, label, show(input));
  assert.equal(out.raisesCard, raisesCard, show(input));
});

scenario("mid-competency, more to do",
  { ceComplete: false, atCeEnd: false, answeredBefore: false,
    assessmentRemaining: 100, hasNextControl: true, hasNextOwed: true },
  "Next control", false);

scenario("the fifth answer of five, walked in order (N30, N33)",
  { ceComplete: true, atCeEnd: true, answeredBefore: false,
    assessmentRemaining: 100, hasNextControl: true, hasNextOwed: true },
  "Finish this competency", true);

scenario("a hole filled in the MIDDLE that finishes the competency (N40)",
  { ceComplete: true, atCeEnd: false, answeredBefore: false,
    assessmentRemaining: 100, hasNextControl: true, hasNextOwed: true },
  "Finish this competency", true);

scenario("control 132 with a hole still open elsewhere (N38)",
  { ceComplete: false, atCeEnd: true, answeredBefore: false,
    assessmentRemaining: 1, hasNextControl: false, hasNextOwed: true },
  "Next unanswered control", false);

scenario("the last hole anywhere, wherever it sits",
  { ceComplete: true, atCeEnd: false, answeredBefore: false,
    assessmentRemaining: 0, hasNextControl: true, hasNextOwed: false },
  "Complete the assessment", true);

scenario("re-reading a middle control of a finished competency",
  { ceComplete: true, atCeEnd: false, answeredBefore: true,
    assessmentRemaining: 50, hasNextControl: true, hasNextOwed: true },
  "Next control", false);

scenario("revising the LAST control of a finished competency (N33c)",
  { ceComplete: true, atCeEnd: true, answeredBefore: true,
    assessmentRemaining: 50, hasNextControl: true, hasNextOwed: true },
  "Review this competency", true);

scenario("revising the last control when everything is answered",
  { ceComplete: true, atCeEnd: true, answeredBefore: true,
    assessmentRemaining: 0, hasNextControl: false, hasNextOwed: false },
  "Review before submitting", true);

scenario("skipping forward with nothing picked leaves the competency open",
  { ceComplete: false, atCeEnd: false, answeredBefore: false,
    assessmentRemaining: 132, hasNextControl: true, hasNextOwed: true },
  "Next control", false);
