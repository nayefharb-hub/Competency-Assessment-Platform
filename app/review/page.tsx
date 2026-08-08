import Link from "@/app/link";
import { requireRole } from "@/lib/auth";
import { getFramework } from "@/lib/framework";
import { completionStats, listAssessments, loadAssessment } from "@/lib/db/assessment";
import { fmtLevel } from "@/lib/rollup";
import { acceptAllAction, approveAction, saveRevisionsAction } from "@/app/actions";
import type { Assessment, CompletionStats } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Assessor workspace.
 *
 * Without ?a= it is the cycle overview: who has finished, how long they took,
 * and what is waiting to be reviewed. With ?a= it is review-and-revise for one
 * person — every control pre-filled with the PM's self-score, so the job is to
 * accept or override rather than re-score from scratch.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; error?: string; revised?: string; accepted?: string }>;
}) {
  const { a, error, revised, accepted } = await searchParams;
  await requireRole("assessor", "admin");

  if (!a) return <Overview error={error} />;

  const [fw, assessment] = await Promise.all([getFramework(), loadAssessment(a)]);
  const scores = new Map(assessment.scores.map((s) => [s.control_code, s]));
  const touched = assessment.scores.filter((s) => s.assessor_touched).length;
  const scorable = fw.activeControls.length;
  const coverage = scorable === 0 ? 0 : Math.round((touched / scorable) * 100);
  const pending = fw.activeControls.filter(
    (c) => scores.get(c.code)?.assessor_level === null || scores.get(c.code) === undefined,
  ).length;
  // Archived records stay readable — that is the point of archiving rather than
  // deleting — but nothing on them may be changed, and the screen has to say so
  // or an assessor will wonder why the buttons vanished.
  const isArchived = assessment.deleted_at != null;
  const open = assessment.state === "self_submitted" && !isArchived;

  const byCe = fw.data.competence_elements
    .map((ce) => ({ ce, controls: fw.activeControls.filter((c) => c.ce_code === ce.code) }))
    .filter((g) => g.controls.length > 0);

  return (
    <div className="section">
      <div className="sec-head">
        <h2>Review &amp; revise — {assessment.assessee_name}</h2>
        <span className="rule" />
        <span className="eyebrow">
          cycle {assessment.cycle} · {assessment.profile} profile
        </span>
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {isArchived && (
        <div className="banner banner-warn" role="status">
          This assessment is <b>archived</b>
          {assessment.deleted_at ? ` (${assessment.deleted_at.slice(0, 10)})` : ""}
          {assessment.deleted_reason ? ` — “${assessment.deleted_reason}”` : ""}. It is
          excluded from the overview and from every completion figure, and nothing on it
          can be changed. Its scores and timings are kept, so the numbers reported for
          this cycle can still be reconciled. Restore it from{" "}
          <Link href="/admin/people">People</Link>.
        </div>
      )}
      {revised && (
        <div className="banner banner-ok" role="status">
          Saved {revised} revision{revised === "1" ? "" : "s"}.
        </div>
      )}
      {accepted && (
        <div className="banner banner-ok" role="status">
          Accepted {accepted} self-score{accepted === "1" ? "" : "s"} as scored.
        </div>
      )}
      {assessment.state === "draft" && (
        <div className="banner banner-warn" role="status">
          {assessment.assessee_name} has not submitted yet — nothing to review.
        </div>
      )}
      {assessment.state === "approved" && (
        <div className="banner banner-ok" role="status">
          Approved{assessment.approved_at ? ` on ${assessment.approved_at.slice(0, 10)}` : ""} and
          locked. Targets were frozen at approval. <Link href={`/results?a=${assessment.id}`}>See results</Link>.
        </div>
      )}

      <div className="card pad">
        <p className="note" style={{ marginBottom: 6 }}>
          Every control is pre-filled with the PM’s self-score. Accept the assessment as it
          stands, or override the controls you disagree with — your score is the one that
          appears in the results. Both are kept: the difference is itself signal.
        </p>
        <div className="reviewbar">
          <span className="note">
            Review coverage <b className="tnum">{coverage}%</b> ·{" "}
            <b className="tnum">{touched}</b>/<span className="tnum">{scorable}</span> controls
            revised · <b className="tnum">{pending}</b> still unset
          </span>
        </div>

        <form action={saveRevisionsAction}>
          <input type="hidden" name="assessment" value={assessment.id} />

          {byCe.map((g) => (
            <div key={g.ce.code} style={{ marginTop: 18 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>
                {g.ce.code} {g.ce.name} · target{" "}
                {fmtLevel(fw.data.ce_targets.find((t) => t.ce_code === g.ce.code)?.target ?? null)}
              </div>
              {g.controls.map((c) => {
                const s = scores.get(c.code);
                const self = s?.self_level ?? null;
                const assessor = s?.assessor_level ?? null;
                const changed = self !== null && assessor !== null && self !== assessor;
                return (
                  <div className="rrow" key={c.code}>
                    <div className="rcode tnum">{c.code}</div>
                    <div>
                      <div style={{ fontSize: "var(--fs-prose)", fontWeight: 600 }}>{c.indicator}</div>
                      <div className="note" style={{ marginTop: 3 }}>
                        PM self-scored{" "}
                        <b className="tnum">
                          {fw.labelOf(self)}
                          {self !== null && ` (${self})`}
                        </b>{" "}
                        · target <b className="tnum">{c.target_level ?? "—"}</b>
                        {s?.evidence && <> · “{s.evidence}”</>}
                      </div>
                      <div className="revise">
                        <label htmlFor={`lv-${c.code}`} className="cap">
                          Your score
                        </label>
                        <input type="hidden" name={`was:${c.code}`} value={assessor ?? ""} />
                        <select
                          className="input"
                          id={`lv-${c.code}`}
                          name={`level:${c.code}`}
                          defaultValue={assessor ?? ""}
                          disabled={!open}
                        >
                          <option value="">— not set —</option>
                          {fw.scaleLevels.map((l) => (
                            <option key={l.level} value={l.level}>
                              {l.level} · {l.label}
                            </option>
                          ))}
                        </select>
                        {/* A pre-filled score is not a reviewed score. Saying
                            "accepted" before anyone looked would make review
                            coverage a lie, which is the one thing this screen
                            exists to keep honest. */}
                        {s?.assessor_touched ? (
                          <span className="edited">✎ Reviewed by you</span>
                        ) : assessor !== null ? (
                          <span className="prefilled">Pre-filled from self-score</span>
                        ) : (
                          <span className="muted" style={{ fontSize: "var(--fs-label)" }}>Not set</span>
                        )}
                        {changed && (
                          <span className="note">
                            (was {fw.labelOf(self)} {self})
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {open && (
            <div className="actionbar">
              <button className="btn btn-primary" type="submit">
                Save revisions
              </button>
            </div>
          )}
        </form>

        {open && (
          <div className="actionbar">
            <form action={acceptAllAction}>
              <input type="hidden" name="assessment" value={assessment.id} />
              <button className="btn btn-ghost" type="submit">
                Accept all remaining ({pending})
              </button>
            </form>
            <form action={approveAction}>
              <input type="hidden" name="assessment" value={assessment.id} />
              <button className="btn btn-accent" type="submit" disabled={pending > 0}>
                Approve assessment
              </button>
            </form>
            <span className="note">
              {pending > 0
                ? "Every active control needs a score before you can approve."
                : "Approving freezes the targets and locks the record."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- overview */

async function Overview({ error }: { error?: string }) {
  const [fw, assessments, stats] = await Promise.all([
    getFramework(),
    listAssessments(),
    completionStats(),
  ]);
  // Every assessment is listed and openable — including the Head of PMO's own,
  // which is how you walk the loop solo. Every row is also COUNTED: an
  // assessment now exists only because an admin assigned it, so there is no
  // longer such a thing as a row that appeared unbidden and has to be excluded.
  const activeCodes = new Set(fw.activeControls.map((c) => c.code));

  return (
    <div className="section">
      <div className="sec-head">
        <h2>Assessment cycle {stats.cycle}</h2>
        <span className="rule" />
        <span className="eyebrow">{fw.activeControls.length} active controls per person</span>
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}

      <Completion stats={stats} />

      <div className="card pad" style={{ marginTop: 20 }}>
        <div className="cap" style={{ marginBottom: 10 }}>PEOPLE</div>
        {assessments.length === 0 && (
          <p className="note">
            Nobody has been assigned this cycle yet.{" "}
            <Link href="/admin/people">Assign it from People</Link> — an assessment exists
            only once you do, which is what makes the completion figures above mean
            something.
          </p>
        )}
        <div className="tablewrap">
          <table className="grid stacked">
            <thead>
              <tr>
                <th>Name</th>
                <th>State</th>
                <th className="num">Scored</th>
                <th>Finished</th>
                <th className="num">Hours</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assessments.map((a) => {
                const scored = a.scores.filter(
                  (s) => s.self_level !== null && activeCodes.has(s.control_code),
                ).length;
                const hours =
                  a.started_at && a.completed_at
                    ? (Date.parse(a.completed_at) - Date.parse(a.started_at)) / 3_600_000
                    : null;
                const row = { scored, finished: a.completed_at != null, hours };
                return (
                  <tr key={a.id}>
                    <td data-label="Name">{a.assessee_name}</td>
                    <td data-label="State">
                      <StateChip a={a} />
                    </td>
                    <td className="num tnum" data-label="Scored">
                      {row?.scored ?? 0}/{fw.activeControls.length}
                    </td>
                    <td data-label="Finished">{row?.finished ? "Yes" : "—"}</td>
                    <td className="num tnum" data-label="Hours">
                      {row?.hours == null
                        ? "—"
                        : row.hours < 0.05
                          ? "<0.1"
                          : row.hours.toFixed(1)}
                    </td>
                    <td data-label="">
                      <Link href={`/review?a=${a.id}`}>
                        {a.state === "self_submitted" ? "Review" : "Open"}
                      </Link>
                      {a.state === "approved" && <> · <Link href={`/results?a=${a.id}`}>Results</Link></>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StateChip({ a }: { a: Assessment }) {
  const label =
    a.state === "approved" ? "Approved" : a.state === "self_submitted" ? "Awaiting review" : "In progress";
  // "In progress" is not a capability deficit — neutral, not red.
  const tier = a.state === "approved" ? "ready" : a.state === "self_submitted" ? "minor" : "neutral";
  return (
    <span className={`pill pill-${tier}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

/**
 * Completion instrumentation (T9) — the prototype's whole thesis. The question
 * the pilot has to answer is whether PMs finish online when they would not
 * finish a spreadsheet, so completion and median time-to-complete are shown
 * first, not buried in an export.
 */
function Completion({ stats }: { stats: CompletionStats }) {
  const rate = stats.assigned === 0 ? 0 : Math.round((stats.finished / stats.assigned) * 100);
  return (
    <div className="card pad">
      <div className="cap" style={{ marginBottom: 10 }}>
        COMPLETION — the metric this pilot exists to test
      </div>
      <div className="tiles" style={{ marginBottom: 0 }}>
        <div className="tile">
          <div className="lbl">Finished</div>
          <div className="big tnum">
            {stats.finished}
            <small> / {stats.assigned}</small>
          </div>
          <div className="mini">
            <i style={{ width: `${rate}%`, background: "var(--accent)" }} />
          </div>
          <div className="note" style={{ marginTop: 8 }}>
            Out of {stats.assigned} assigned this cycle
            {stats.archived > 0 && (
              <>
                {" · "}
                <b>
                  {stats.archived} archived, excluded
                </b>
                {stats.archived_finished > 0 && (
                  <>
                    {" "}({stats.archived_finished} of them finished, so the median
                    moved)
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <div className="tile">
          <div className="lbl">Median time to complete</div>
          <div className="big tnum">
            {/* under an hour, hours round to 0.0 and say nothing useful */}
            {stats.median_hours === null ? (
              "—"
            ) : stats.median_hours < 1 ? (
              <>
                {Math.max(1, Math.round(stats.median_hours * 60))}
                <small> min</small>
              </>
            ) : (
              <>
                {stats.median_hours.toFixed(1)}
                <small> hours</small>
              </>
            )}
          </div>
          <div className="note" style={{ marginTop: 8 }}>
            First score to submit, over {stats.finished} finished
          </div>
        </div>
        <div className="tile">
          <div className="lbl">Started · approved</div>
          <div className="big tnum">
            {stats.started}
            <small> · {stats.approved}</small>
          </div>
          <div className="note" style={{ marginTop: 8 }}>
            Started = at least one control scored
          </div>
        </div>
      </div>
      <p className="note" style={{ marginTop: 12 }}>
        Baseline for comparison (has this team had completion problems with the
        spreadsheet before?) is still an open desk check — see docs/STATUS.md.
      </p>
    </div>
  );
}
