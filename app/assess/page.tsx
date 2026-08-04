import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getAssesseeFramework } from "@/lib/framework";
import {
  currentCycle, findArchivedAssessment, findAssessment, scoresFor,
} from "@/lib/db/assessment";
import { saveSelfScoreAction } from "@/app/actions";
import NotAssigned from "./not-assigned";

export const dynamic = "force-dynamic";

/**
 * PM self-assessment — one control at a time, persisted to Supabase.
 *
 * The framework arrives through getAssesseeFramework(), which has already
 * stripped the target, priority, reason and kib_note. Blinding the PM to the
 * target is methodology, not decoration: seeing it anchors the self-score.
 *
 * LAYOUT (N14): ICB4 prose on the left, the scoring panel on the right and
 * pinned. The two are separate cards because they are separate jobs — read the
 * indicator, then answer — and because a pinned panel has to be able to stay
 * put while the prose beside it scrolls. The longest indicator in ICB4 runs to
 * 2,596 characters and is never edited, so no layout makes every control fit a
 * laptop screen; what this one guarantees is that the answer and Save never
 * leave it. Below 1100px it collapses to one column with the actions pinned.
 */
export default async function AssessPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; error?: string }>;
}) {
  const { c, error } = await searchParams;
  const user = await requireUser();
  const [fw, row] = await Promise.all([getAssesseeFramework(), findAssessment(user.id)]);
  if (!row) {
    // Distinguish "never assigned" from "yours was archived" — see NotAssigned.
    const archived = await findArchivedAssessment(user.id);
    return <NotAssigned cycle={currentCycle()} archived={archived} />;
  }
  // Only the scores: this screen renders nothing from the person, the profile
  // or the target snapshot, and a PM loads it 132 times.
  const scores = await scoresFor(user, row);

  const code = c && fw.controlByCode(c)?.active ? c : fw.activeControls[0].code;
  const control = fw.controlByCode(code)!;
  const ce = fw.ceOf(control.ce_code);
  const measures = fw.measuresFor(code);
  const pos = fw.controlPosition(code);
  const { prev, next } = fw.neighbours(code);

  const score = scores.find((s) => s.control_code === code);
  const answered = scores.filter((s) => s.self_level !== null).length;
  const locked = row.state !== "draft";

  return (
    <div className="section assess-wide">
      <div className="assess-nav">
        <Link className="btn btn-secondary btn-sm" href="/assess/controls">
          ← Back to controls
        </Link>
        <span className="note">
          Control <b className="tnum">{pos}</b> of{" "}
          <b className="tnum">{fw.activeControls.length}</b> ·{" "}
          <b className="tnum">{answered}</b> scored so far · you can jump back to any control
        </span>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {locked && (
        <div className="banner banner-warn" role="status">
          You submitted this assessment on{" "}
          {row.submitted_at?.slice(0, 10) ?? "submission"} — it is with the
          Head of PMO now, so scores can no longer be changed.
        </div>
      )}

      <div className="assess-grid">
        {/* ---- what the control asks: ICB4 source text, capped at --measure ---- */}
        <div className="card pad">
          <div className="crumb">
            <span className="area">{control.area}</span>
            <span className="sep">›</span>
            <span>
              {ce?.code} {ce?.name}
            </span>
            <span className="sep">›</span>
            <span>
              Control <b>{control.code}</b>
            </span>
          </div>

          <h2 style={{ fontSize: 17, fontWeight: 650, marginBottom: 2 }}>{control.indicator}</h2>
          {control.description && (
            <p className="lede" style={{ margin: "8px 0 0", fontSize: 15 }}>
              {control.description}
            </p>
          )}

          {measures.length > 0 && (
            <>
              <div className="mh">
                Measures — what “doing this” looks like{" "}
                <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                  (reference only, not scored)
                </span>
              </div>
              <ul className="measures">
                {measures.map((m) => (
                  <li key={`${m.control_code}-${m.no}`}>{m.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        {/* ---- your answer: pinned, so it never scrolls out of reach ---- */}
        <div className="scorepanel">
          <div className="card pad">
            <form action={saveSelfScoreAction}>
              <input type="hidden" name="control" value={code} />
              <input type="hidden" name="next" value={next?.code ?? ""} />

              <div className="mh" style={{ color: "var(--ink)", marginTop: 0 }}>
                Your level{" "}
                <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                  🔒 target hidden while you self-score
                </span>
              </div>
              <div className="optlist" role="radiogroup" aria-label="Proficiency level">
                {fw.scaleLevels.map((s) => (
                  <label className="opt" key={s.level}>
                    <input
                      type="radio"
                      name="level"
                      value={s.level}
                      defaultChecked={score?.self_level === s.level}
                      disabled={locked}
                    />
                    <span>
                      <b>{s.label}</b>
                      <span className="gloss">{fw.glossOf(s.level)}</span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="evidence">Evidence or example (optional, not scored)</label>
                <input
                  className="input"
                  id="evidence"
                  name="evidence"
                  defaultValue={score?.evidence ?? ""}
                  disabled={locked}
                  placeholder="A short example of when you did this…"
                />
              </div>

              {/* No inline styles here: the mobile rule turns this into a fixed
                  bar, and an inline style would beat the media query. */}
              <div className="assess-actions">
                {!locked && (
                  <button className="btn btn-primary" type="submit">
                    {next ? "Save & next control" : "Save & review before submitting"}
                  </button>
                )}
                {prev && (
                  <Link className="btn btn-secondary" href={`/assess?c=${prev.code}`}>
                    ← Previous
                  </Link>
                )}
                {locked && next && (
                  <Link className="btn btn-secondary" href={`/assess?c=${next.code}`}>
                    Next →
                  </Link>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
