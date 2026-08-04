import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getAssesseeFramework } from "@/lib/framework";
import {
  currentCycle, findArchivedAssessment, findAssessment, loadForAssessee,
} from "@/lib/db/assessment";
import { submitAssessmentAction } from "@/app/actions";
import NotAssigned from "../not-assigned";

export const dynamic = "force-dynamic";

/**
 * Control index + submit. Doubles as the progress view: a PM who is part-way
 * through can see exactly what is left, which is the thing a spreadsheet is
 * worst at and the reason this prototype exists.
 */
export default async function ControlsIndex({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string; submitted?: string; error?: string; show?: string;
  }>;
}) {
  const { saved, submitted, error, show } = await searchParams;
  const user = await requireUser();
  const [fw, row] = await Promise.all([getAssesseeFramework(), findAssessment(user.id)]);
  if (!row) {
    // Distinguish "never assigned" from "yours was archived" — see NotAssigned.
    const archived = await findArchivedAssessment(user.id);
    return <NotAssigned cycle={currentCycle()} archived={archived} />;
  }
  const assessment = await loadForAssessee(user, row.id);

  const scored = new Map(
    assessment.scores.filter((s) => s.self_level !== null).map((s) => [s.control_code, s.self_level!]),
  );
  const total = fw.activeControls.length;
  const done = fw.activeControls.filter((c) => scored.has(c.code)).length;
  const complete = done === total;
  const draft = assessment.state === "draft";
  const firstUnscored = fw.activeControls.find((c) => !scored.has(c.code));

  /* Filter (N5) — a query parameter, not the app's first client component.
     The counts above and inside every heading keep reporting the WHOLE
     assessment: a filter is a way of looking at 132 controls, not a way of
     having fewer, and "8/8 scored" under a "not scored" filter would be a lie
     about progress on the one screen whose job is to report it. */
  const filter: "all" | "todo" | "done" =
    show === "todo" || show === "done" ? show : "all";
  const matches = (code: string) =>
    filter === "all" || (filter === "done" ? scored.has(code) : !scored.has(code));

  const byCe = fw.data.competence_elements.map((ce) => ({
    ce,
    controls: fw.activeControls.filter((c) => c.ce_code === ce.code),
  }));
  const shown = fw.activeControls.filter((c) => matches(c.code)).length;

  return (
    <div className="section">
      <div className="sec-head">
        <h2>Your assessment</h2>
        <span className="rule" />
        <span className="eyebrow">
          cycle {assessment.cycle} · {total} active controls
        </span>
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {submitted && (
        <div className="banner banner-ok" role="status">
          Submitted. The Head of PMO will review your scores; your results appear here
          once the review is approved.
        </div>
      )}
      {saved && !submitted && (
        <div className="banner banner-ok" role="status">
          Saved. You can stop here and pick up where you left off.
        </div>
      )}

      <div className="card pad" style={{ marginBottom: 20 }}>
        <div className="progress-head">
          <div>
            <div className="cap">PROGRESS</div>
            <div className="big tnum" style={{ fontSize: 26, fontWeight: 680 }}>
              {done}
              <small className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / {total} controls scored</small>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {draft && firstUnscored && (
              <Link className="btn btn-primary" href={`/assess?c=${firstUnscored.code}`}>
                {done === 0 ? "Start" : "Continue"} — control {fw.controlPosition(firstUnscored.code)}
              </Link>
            )}
            {draft && (
              <form action={submitAssessmentAction}>
                <button className="btn btn-accent" type="submit" disabled={!complete}>
                  Submit for review
                </button>
              </form>
            )}
          </div>
        </div>
        <div className="progress" aria-hidden="true">
          <i style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} />
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          {assessment.state === "draft" && !complete && (
            <>Score every active control to submit — {total - done} to go.</>
          )}
          {assessment.state === "draft" && complete && (
            <>All controls scored. Submitting hands the assessment to the Head of PMO; you
              cannot change scores afterwards.</>
          )}
          {assessment.state === "self_submitted" && (
            <>Submitted{assessment.submitted_at ? ` on ${assessment.submitted_at.slice(0, 10)}` : ""} — with the Head of PMO for review.</>
          )}
          {assessment.state === "approved" && (
            <>Approved — <Link href="/results">see your results</Link>.</>
          )}
        </p>
      </div>

      <div className="filterbar">
        <span className="cap">Show</span>
        {([
          ["all", "All", total],
          ["todo", "Not scored", total - done],
          ["done", "Scored", done],
        ] as const).map(([value, label, count]) => (
          <Link
            key={value}
            href={value === "all" ? "/assess/controls" : `/assess/controls?show=${value}`}
            className="filterchip"
            aria-current={filter === value ? "true" : undefined}
          >
            {label} <span className="tnum">{count}</span>
          </Link>
        ))}
      </div>

      {filter !== "all" && shown === 0 && (
        <div className="card pad">
          <p className="note" style={{ margin: 0 }}>
            {filter === "todo"
              ? "Nothing left — every active control has a score."
              : "Nothing scored yet."}{" "}
            <Link href="/assess/controls">Show all {total}</Link>.
          </p>
        </div>
      )}

      {(["Perspective", "People", "Practice"] as const)
        .filter((area) =>
          byCe.some((g) => g.ce.area === area && g.controls.some((c) => matches(c.code))),
        )
        .map((area) => (
        <div key={area} style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>{area}</div>
          <div className="card pad">
            {byCe
              .filter((g) => g.ce.area === area)
              .filter((g) => g.controls.some((c) => matches(c.code)))
              .map((g) => (
                <div key={g.ce.code} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>
                    {g.ce.code} {g.ce.name}{" "}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      · {g.controls.filter((c) => scored.has(c.code)).length}/{g.controls.length} scored
                    </span>
                  </div>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                    {g.controls.filter((c) => matches(c.code)).map((c) => {
                      const level = scored.get(c.code);
                      return (
                        <li
                          key={c.code}
                          className={`crow ${level === undefined ? "crow-todo" : "crow-done"}`}
                        >
                          <Link href={`/assess?c=${c.code}`}>
                            <span className="tnum ccode">{c.code}</span>{" "}
                            <span className="cind">{c.indicator}</span>
                          </Link>{" "}
                          {level === undefined ? (
                            <span className="tick tick-todo">not scored</span>
                          ) : (
                            <span className="tick tick-done">✓ {fw.labelOf(level)}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
