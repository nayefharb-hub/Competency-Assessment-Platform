import Link from "next/link";
import {
  activeControls, ceOf, controlByCode, controlPosition, measuresFor, neighbours,
  scaleLevels, LEVEL_GLOSS,
} from "@/lib/framework";

export const dynamic = "force-static";

/**
 * PM self-assessment — one control at a time.
 *
 * Shows the full context the PM needs to score honestly:
 *   area → competence element → control → the ICB4 indicator text → its measures
 * The target level is deliberately NOT shown here (methodology: stop anchoring).
 */
export default async function AssessPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { c } = await searchParams;
  const code = c && controlByCode(c)?.active ? c : activeControls[0].code;
  const control = controlByCode(code)!;
  const ce = ceOf(control.ce_code);
  const measures = measuresFor(code);
  const pos = controlPosition(code);
  const { prev, next } = neighbours(code);

  return (
    <div className="section">
      <div className="card pad">
        <div className="assess-nav">
          <Link className="btn btn-secondary btn-sm" href="/assess/controls">
            ← Back to controls
          </Link>
          <span className="note">
            Control <b className="tnum">{pos}</b> of{" "}
            <b className="tnum">{activeControls.length}</b> · you can jump back to any control
          </span>
        </div>

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
          <p style={{ margin: "8px 0 0", fontSize: 15 }}>{control.description}</p>
        )}

        {control.kib_note && (
          <div
            className="ro"
            style={{ marginTop: 14, borderLeft: "3px solid var(--accent)" }}
          >
            <div className="cap" style={{ marginBottom: 4, fontWeight: 600 }}>
              KIB context
            </div>
            <p>{control.kib_note}</p>
          </div>
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

        <div className="mh" style={{ color: "var(--ink)" }}>
          Your level{" "}
          <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
            🔒 target hidden while you self-score
          </span>
        </div>
        <div className="optlist" role="radiogroup" aria-label="Proficiency level">
          {scaleLevels.map((s) => (
            <label className="opt" key={s.level}>
              <input type="radio" name="level" value={s.level} defaultChecked={false} />
              <span>
                <b>{s.label}</b>
                <span className="gloss">{LEVEL_GLOSS[s.level]}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="evidence">Evidence or example (optional, not scored)</label>
          <input className="input" id="evidence" placeholder="A short example of when you did this…" />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          {prev && (
            <Link className="btn btn-secondary" href={`/assess?c=${prev.code}`}>
              ← Previous
            </Link>
          )}
          {next ? (
            <Link className="btn btn-primary" href={`/assess?c=${next.code}`}>
              Save &amp; next control
            </Link>
          ) : (
            <button className="btn btn-primary" type="button">
              Save &amp; submit assessment
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
