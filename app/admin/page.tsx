import Link from "@/app/link";
import { requireRole } from "@/lib/auth";
import { getFramework } from "@/lib/framework";
import { saveControlAction } from "@/app/actions";
import {
  controlsHref, editorHref, filteredNeighbours, filterQuery, parseControlFilter,
  type ControlFilterParams,
} from "@/lib/control-filter";

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
 *
 * THE FILTER TRAVELS WITH THE ADMIN. Arriving from the framework table carries
 * that table's filter in the query string, so Previous and Next walk the view
 * the admin was looking at — "check every control targeted Competent" is one
 * pass through this screen rather than 41 round trips to the list. The set and
 * its order come from `lib/control-filter.ts`, which the table renders from too;
 * a second copy here would walk a different list on the day someone changed one
 * of them.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<ControlFilterParams & { c?: string; saved?: string; error?: string }>;
}) {
  const params = await searchParams;
  const { c, saved, error } = params;
  await requireRole("admin");
  const fw = await getFramework();

  const filter = parseControlFilter(params, fw);
  const code = c && fw.controlByCode(c) ? c : fw.activeControls[0].code;
  const control = fw.controlByCode(code)!;
  const ce = fw.ceOf(control.ce_code);
  const measures = fw.measuresFor(code);
  const { prev, next, position, total } = filteredNeighbours(fw, filter, code);

  /* The way back. With a filter, it is the filtered view; without one, the
     control's own competency — an admin editing 4.5.2.3 is working on 4.5.2,
     and dropping them at the top of 133 rows would make them find their place
     again (N44). */
  const backHref = filterQuery(filter)
    ? controlsHref(filter)
    : controlsHref(filter, { ce: ce?.code ?? null });
  const backLabel = filterQuery(filter)
    ? `Back to the ${total} filtered controls`
    : ce?.code ? `${ce.code} ${ce.name}` : "All controls";

  return (
    <div className="section reading">
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
          <Link className="btn btn-secondary btn-sm" href={backHref}>
            ← {backLabel}
          </Link>
          <span className="note">
            Editing <b className="tnum">{control.code}</b>
            {position > 0 && total > 1 && (
              <> · <span className="tnum">{position}</span> of <span className="tnum">{total}</span></>
            )}
          </span>
        </div>

        {/* Previous / Next — so the framework can be worked through one control
            at a time. Without these, every edit cost a trip back to the table
            and a hunt for the place you had reached. Rendered even when one end
            is missing, so the pair does not jump around as the admin walks. */}
        {(prev || next) && (
          <div className="assess-nav" style={{ marginTop: -4 }}>
            <span className="note">
              {prev
                ? <>Previous: <b className="tnum">{prev.code}</b></>
                : <span className="muted">First in this view</span>}
            </span>
            <span style={{ display: "flex", gap: 8 }}>
              {prev ? (
                <Link className="btn btn-secondary btn-sm" href={editorHref(prev.code, filter)}>
                  ← {prev.code}
                </Link>
              ) : (
                <span className="btn btn-secondary btn-sm" aria-disabled="true" style={{ opacity: .45 }}>
                  ← Previous
                </span>
              )}
              {next ? (
                <Link className="btn btn-secondary btn-sm" href={editorHref(next.code, filter)}>
                  {next.code} →
                </Link>
              ) : (
                <span className="btn btn-secondary btn-sm" aria-disabled="true" style={{ opacity: .45 }}>
                  Next →
                </span>
              )}
            </span>
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
          {/* The filter survives the save, so an admin working through a
              filtered set is not dumped back into all 133 by pressing Save. */}
          <input type="hidden" name="filter" value={filterQuery(filter)} />

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

          {/* WHAT THE LEVELS MEAN, on the screen where the target is chosen.
              The admin was picking "3 · Competent" from a dropdown with nothing
              on the page saying how Competent differs from Practised — the
              distinction the whole benchmark rests on. This is the APM
              APPLICATION axis, which is the axis the scale is defined on
              (domain rule), and it is the same wording the PM is shown while
              self-scoring, so both sides of the assessment are reading one
              definition rather than two. */}
          <details className="scale-help">
            <summary>
              What the levels mean
              <span className="muted"> · APM 0–5, Application axis</span>
            </summary>
            <ul className="scale-levels">
              {fw.scaleLevels.map((s) => (
                <li key={s.level} className={s.level === control.target_level ? "is-target" : undefined}>
                  <span className="lvl-n tnum">{s.level}</span>
                  <span>
                    <b>
                      {s.label}
                      {s.level === control.target_level && (
                        <span className="lvl-tag"> target for this control</span>
                      )}
                    </b>
                    <span className="lvl-text">{s.application || s.knowledge}</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>

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
              {/* A TEXTAREA, not an input. These run to two or three sentences —
                  "Partial fit. Setting or aligning project goals to strategy sits
                  above a KIB PM's authority…" — and a single-line input showed
                  the first forty characters of a justification that has to be
                  read to be judged. */}
              <textarea
                className="input"
                id="reason"
                name="reason"
                rows={3}
                defaultValue={control.reason ?? ""}
                placeholder="Why this is scoped down…"
              />
            </div>
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="kib">
              KIB context &amp; clarification — added alongside, never replaces the ICB4 text above
            </label>
            <textarea
              className="input"
              id="kib"
              name="kib_note"
              rows={3}
              defaultValue={control.kib_note ?? ""}
              placeholder="Add KIB context for this control…"
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button className="btn btn-primary" type="submit">
              Save changes
            </button>
            {next && (
              <Link className="btn btn-secondary" href={editorHref(next.code, filter)}>
                Skip to {next.code} →
              </Link>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
