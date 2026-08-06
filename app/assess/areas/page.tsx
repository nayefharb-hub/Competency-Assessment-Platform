import Link from "@/app/link";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { getAssesseeFramework } from "@/lib/framework";
import {
  currentCycle, findArchivedAssessment, findAssessmentWithScores,
} from "@/lib/db/assessment";
import { estimateLabel } from "@/lib/duration";
import { scoredCodes, shapeOf } from "@/lib/shape";
import NotAssigned from "../not-assigned";

export const dynamic = "force-dynamic";

/**
 * The way in — the shape of the work rather than one control out of 132.
 *
 * TARGETS ARE ABSENT HERE, and that is load-bearing rather than an oversight:
 * this page uses getAssesseeFramework(), which nulls them, and it renders
 * progress only. Seeing "target 3" while self-scoring anchors the answer to 3,
 * which is why CLAUDE.md makes blinding a methodology rule. An e2e check
 * asserts no target reaches this screen, so a future "helpful" addition goes
 * red rather than quietly degrading every self-score after it.
 */
export default async function AreasPage() {
  const user = await requireUser();
  const [fw, mine] = await Promise.all([getAssesseeFramework(), findAssessmentWithScores(user)]);
  if (!mine) {
    const archived = await findArchivedAssessment(user.id);
    return <NotAssigned cycle={currentCycle()} archived={archived} />;
  }
  const { scores } = mine;

  const done = scoredCodes(scores);
  const areas = shapeOf(fw.activeControls, fw.ceOf, fw.data.measures, done,
    fw.data.areas.map((a) => a.name));
  const totalCes = areas.reduce((s, a) => s + a.ces.length, 0);
  const doneCes = areas.reduce((s, a) => s + a.ces.filter((c) => c.scored === c.controls.length).length, 0);
  const nextUp = areas.find((a) => a.firstUnscored);
  /* "Continue where you left off" has to mean the same thing as the menu
     (D12), which resumes from cap.last. Sending it to the first UNSCORED
     control instead gave two buttons one promise and two destinations — and
     because it passes ?c=, it would then overwrite the cookie with the wrong
     answer. First-unscored stays as the fallback, exactly as on /assess. */
  const remembered = (await cookies()).get("cap.last")?.value;
  const resume = (remembered && fw.controlByCode(remembered)?.active
    ? remembered
    : nextUp?.firstUnscored?.code) ?? null;

  /* This screen is now the only one a PM sees, so it has to represent every
     state the assessment can be in — not just the one it was written for.

     It previously asked `if (!mine)` and nothing else, which made it
     accidentally correct for a draft and wrong for everything after. A PM who
     had submitted was told to "Continue where you left off", and the control
     page it offered locks itself the moment state leaves draft.

     Four states, because DRAFT is two different situations. A PM who has
     answered all 132 needs SUBMIT, and Submit lives on /assess/controls — the
     only screen carrying SubmitButton. Without the complete branch, finishing
     out of order (last answer landing mid-competency, so nextAfter's boundary
     never fires) leaves a PM at 132 of 132 with no route to submit at all.

     `complete` is the same predicate /assess/controls uses, over the same
     active controls, so the two screens cannot disagree about whether a PM is
     done. Active only — an inactive control contributes nothing to any rollup
     and must not hold an assessment open. */
  const state = mine.row.state;
  const complete = fw.activeControls.every((ac) => done.has(ac.code));
  const on = (ts: string | null) => (ts ? ` ${ts.slice(0, 10)}` : "");

  return (
    <div className="section">
      <div className="progress-head">
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 680, marginBottom: 4 }}>Your self-assessment</h2>
          {/* A count of competencies, not a prediction about the person (D15).
              "40 minutes left at your pace" is a promise the person falsifies;
              this is a fact, and it names the next action. */}
          <p className="note" style={{ margin: 0 }}>
            {state === "draft" && (
              <>
                <b className="tnum">{doneCes}</b> of <b className="tnum">{totalCes}</b> competencies
                {complete ? " scored" : " complete"}
                {nextUp && <> · next: <b>{nextUp.name}</b></>}
              </>
            )}
            {state === "self_submitted" && (
              <>Submitted{on(mine.row.submitted_at)} · with the Head of PMO for review</>
            )}
            {state === "approved" && <>Approved{on(mine.row.approved_at)}</>}
          </p>
        </div>
        {/* One primary action per state. The draft-complete branch is the one
            that keeps Submit reachable; see the note above. */}
        {state === "draft" && complete && (
          <Link className="btn btn-primary" href="/assess/controls">
            Review and submit
          </Link>
        )}
        {state === "draft" && !complete && resume && (
          <Link className="btn btn-primary" href={`/assess?c=${resume}`}>
            Continue where you left off
          </Link>
        )}
        {state === "self_submitted" && (
          <Link className="btn btn-secondary" href="/assess/controls">
            View your answers
          </Link>
        )}
        {state === "approved" && (
          <Link className="btn btn-primary" href="/results">
            See your results
          </Link>
        )}
      </div>

      <div className="area-grid">
        {areas.map((area) => {
          const complete = area.scored === area.controls;
          const pct = area.controls === 0 ? 0 : Math.round((area.scored / area.controls) * 100);
          return (
            <Link
              key={area.name}
              className="card pad area-card"
              href={`/assess/area/${encodeURIComponent(area.name)}`}
            >
              <div className="mh" style={{ marginTop: 0 }}>{area.name}</div>
              <p className="note" style={{ margin: "2px 0 10px" }}>
                <b className="tnum">{area.ces.length}</b> competencies ·{" "}
                <b className="tnum">{area.controls}</b> controls
              </p>
              <div className="progress" aria-hidden="true">
                <i style={{ width: `${pct}%` }} />
              </div>
              <p className="note" style={{ margin: "8px 0 0" }}>
                {complete
                  ? "Complete"
                  : <><b className="tnum">{area.scored}</b> of <b className="tnum">{area.controls}</b> scored</>}
                {/* A property of the work, not of the reader (D15b) — a cook
                    time. It answers "can I start this now?". */}
                {!complete && <> · {estimateLabel(area.estimate)}</>}
              </p>
            </Link>
          );
        })}
      </div>

      <p className="note" style={{ marginTop: 18 }}>
        Prefer the full list? <Link href="/assess/controls">All {fw.activeControls.length} controls</Link>.
      </p>

      {/* THE DISCLOSURE (D21/D28). Said once, here, where a PM starts — not on
          every control, which would read as a stopwatch over the shoulder.
          It is load-bearing rather than legal furniture: pace is recorded so a
          rushed assessment can be caught before it distorts the results, and
          telling people that is the whole difference between an instrument and
          a trap. The link is not decoration either — being able to see your own
          figures is what makes the disclosure true. */}
      <p className="note" style={{ marginTop: 6 }}>
        Time spent on each control is recorded, so that an assessment rushed to get it finished
        can be spotted before it reaches your results. Nobody is scored on speed, and you can see
        your own figures on <Link href="/analysis">Analysis</Link>.
      </p>
    </div>
  );
}
