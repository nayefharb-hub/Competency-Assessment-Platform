import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getFramework } from "@/lib/framework";
import { saveControlAction } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * Framework admin — edits the tunable layer only, straight into Postgres.
 *
 * The ICB4 indicator, description and measures are rendered read-only and the
 * save action refuses to accept them at all. That is not squeamishness: the
 * source text has to stay fixed for year-over-year comparison to mean
 * anything, so KIB's wording goes in kib_note, alongside.
 *
 * This is admin editing of THIS framework — deliberately not a framework
 * builder. See CLAUDE.md: no multi-framework authoring until a pilot earns it.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; saved?: string; error?: string }>;
}) {
  const { c, saved, error } = await searchParams;
  await requireRole("admin");
  const fw = await getFramework();

  const code = c && fw.controlByCode(c) ? c : fw.activeControls[0].code;
  const control = fw.controlByCode(code)!;
  const ce = fw.ceOf(control.ce_code);
  const measures = fw.measuresFor(code);

  return (
    <div className="section">
      <div className="sec-head">
        <h2>Framework admin</h2>
        <span className="rule" />
        <span className="eyebrow">source text locked · tune the layer around it</span>
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {saved && (
        <div className="banner banner-ok" role="status">
          Saved to the framework. Assessments already approved keep the targets frozen at
          approval — this change affects future rollups only.
        </div>
      )}

      <div className="card pad">
        <div className="assess-nav">
          <Link className="btn btn-secondary btn-sm" href="/admin/controls">
            ← Pick another control
          </Link>
          <span className="note">
            Editing <b className="tnum">{control.code}</b>
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

        {/* read-only ICB4 source, for context while writing clarifications */}
        <div className="ro">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <b style={{ fontSize: 14.5 }}>{control.indicator}</b>
            <span className="lock">🔒 ICB4 — read-only</span>
          </div>
          {control.description && <p>{control.description}</p>}
          {measures.length > 0 && (
            <>
              <div className="mh">Measures (read-only)</div>
              <ul className="measures">
                {measures.map((m) => (
                  <li key={`${m.control_code}-${m.no}`}>{m.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        <form action={saveControlAction}>
          <input type="hidden" name="control" value={control.code} />

          <div className="cols" style={{ marginTop: 16 }}>
            <div className="field">
              <label htmlFor="target">Target level</label>
              <select className="input" id="target" name="target" defaultValue={control.target_level ?? 3}>
                {fw.scaleLevels.map((s) => (
                  <option key={s.level} value={s.level}>
                    {s.level} · {s.label}
                  </option>
                ))}
              </select>
              <div className="note" style={{ marginTop: 6 }}>
                Source: {control.target_source ?? "—"}
                {control.apm_competence && ` · APM: ${control.apm_competence}`}
              </div>
            </div>
            <div className="field">
              <label htmlFor="priority">Priority</label>
              <select className="input" id="priority" name="priority" defaultValue={control.priority ?? "High"}>
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
              </select>
            </div>
          </div>

          <div className="cols" style={{ marginTop: 14 }}>
            <div className="field">
              <label htmlFor="active">Active</label>
              <select className="input" id="active" name="active" defaultValue={control.active ? "yes" : "no"}>
                <option value="yes">Active — counts in rollups</option>
                <option value="no">Inactive — excluded from every rollup</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="reason">Reason (required when not Active/High)</label>
              <input
                className="input"
                id="reason"
                name="reason"
                defaultValue={control.reason ?? ""}
                placeholder="Why this is scoped down…"
              />
            </div>
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="kib">
              KIB context &amp; clarification — added alongside, never replaces the ICB4 text above
            </label>
            <input
              className="input"
              id="kib"
              name="kib_note"
              defaultValue={control.kib_note ?? ""}
              placeholder="Add KIB context for this control…"
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" type="submit">
              Save changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
