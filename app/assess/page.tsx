import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getAssesseeFramework } from "@/lib/framework";
import { getOrCreateAssessment, loadForAssessee } from "@/lib/db/assessment";
import { saveSelfScoreAction } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * PM self-assessment — one control at a time, persisted to Supabase.
 *
 * The framework arrives through getAssesseeFramework(), which has already
 * stripped the target, priority, reason and kib_note. Blinding the PM to the
 * target is methodology, not decoration: seeing it anchors the self-score.
 */
export default async function AssessPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; error?: string }>;
}) {
  const { c, error } = await searchParams;
  const user = await requireUser();
  const [fw, row] = await Promise.all([getAssesseeFramework(), getOrCreateAssessment(user.id)]);
  const assessment = await loadForAssessee(user, row.id);

  const code = c && fw.controlByCode(c)?.active ? c : fw.activeControls[0].code;
  const control = fw.controlByCode(code)!;
  const ce = fw.ceOf(control.ce_code);
  const measures = fw.measuresFor(code);
  const pos = fw.controlPosition(code);
  const { prev, next } = fw.neighbours(code);

  const score = assessment.scores.find((s) => s.control_code === code);
  const answered = assessment.scores.filter((s) => s.self_level !== null).length;
  const locked = assessment.state !== "draft";

  return (
    <div className="section reading">
      <div className="card pad">
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
            {assessment.submitted_at?.slice(0, 10) ?? "submission"} — it is with the
            Head of PMO now, so scores can no longer be changed.
          </div>
        )}

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

        <form action={saveSelfScoreAction}>
          <input type="hidden" name="control" value={code} />
          <input type="hidden" name="next" value={next?.code ?? ""} />

          <div className="mh" style={{ color: "var(--ink)" }}>
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

          <div className="field" style={{ marginTop: 16 }}>
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

          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            {prev && (
              <Link className="btn btn-secondary" href={`/assess?c=${prev.code}`}>
                ← Previous
              </Link>
            )}
            {!locked && (
              <button className="btn btn-primary" type="submit">
                {next ? "Save & next control" : "Save & review before submitting"}
              </button>
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
  );
}
