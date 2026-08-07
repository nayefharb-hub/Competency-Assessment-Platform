import Link from "@/app/link";
import { requireRole } from "@/lib/auth";
import { getFramework } from "@/lib/framework";
import {
  AREAS, controlsHref, editorHref, filteredControls, isFiltered, parseControlFilter,
  type ControlFilterParams,
} from "@/lib/control-filter";
import type { Level } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The framework, as a table you can scan — and the front door to Framework admin
 * (N44).
 *
 * WHAT WAS WRONG. The Framework nav landed on `/admin`, which is the editor for
 * ONE control, so an admin arrived inside 4.3.1.1 with no sense of the whole:
 * "I can't see the framework" was the report. This page existed but was a nested
 * set of link lists — area, then competency, then a bulleted control per line,
 * with target and priority as trailing prose. Nothing could be sorted, filtered
 * or compared, which is what you actually do before a cycle: find the controls
 * whose target is wrong, or check what is switched off.
 *
 * WHY QUERY PARAMETERS AND NOT CLIENT STATE. The same reasoning as the PM's
 * control filter (N5): a filtered view is a thing you send someone or bookmark,
 * the whole framework is already in memory on the server, and a table of 133
 * rows does not need React to hide some of them. No client component is added
 * to the bundle for this.
 *
 * WHY GROUPED **AND** FILTERABLE. The owner asked for both, and they are not in
 * tension: the competency subhead is the row's context, the filters decide which
 * rows exist. Narrow to one competency and you get one group; narrow to
 * "inactive" and you get the two or three groups that contain one.
 *
 * THE COUNTS IN THE HEADER REPORT THE WHOLE FRAMEWORK, never the filtered set —
 * N5's rule, for N5's reason: "133 total · 1 inactive" is a fact about the
 * framework, and making it shrink under a filter would turn the one line whose
 * job is orientation into a lie. The chip counts follow the same rule.
 *
 * THE FILTER ITSELF LIVES IN `lib/control-filter.ts`, not here, because the
 * editor's Previous/Next has to walk exactly the set this table renders. Two
 * copies of that rule would agree until the day they did not.
 */
export default async function AdminControlsIndex({
  searchParams,
}: {
  searchParams: Promise<ControlFilterParams>;
}) {
  await requireRole("admin");
  const params = await searchParams;
  const fw = await getFramework();

  const filter = parseControlFilter(params, fw);
  const ceOf = (code: string) => fw.data.competence_elements.find((e) => e.code === code);
  const areaOfCe = (code: string) => ceOf(code)?.area ?? "";

  const rows = filteredControls(fw, filter);

  /* Framework order — the ICB4 sequence the standard publishes and the PMs saw
     in the workbook, not alphabetical and not database order. */
  const groups = fw.data.competence_elements
    .map((e) => ({ ce: e, controls: rows.filter((c) => c.ce_code === e.code) }))
    .filter((g) => g.controls.length > 0);

  const filtered = isFiltered(filter);
  /* Which competencies the area chips should offer. Selecting an area narrows
     this list; selecting a competency from another area would be unreachable
     rather than empty, so the list follows the area. */
  const cesForPicker = fw.data.competence_elements.filter(
    (e) => !filter.area || e.area === filter.area,
  );

  /* EVERY level on the scale, including the ones no control currently targets.

     This showed only levels in use, on the reasoning that empty chips are
     noise. That was wrong here, and the owner found it the direct way: the
     framework targets only Aware, Practised and Competent today, so Unaware,
     Proficient and Expert were absent from the row — and looking for "filter by
     target Unaware" and finding no such chip reads as "this screen cannot do
     that", which is what was reported.

     Three reasons the full scale is right on THIS screen:
       - it is the EDITING screen. A level with no controls today has some the
         moment an admin retargets one, and a filter that appears and disappears
         as a side effect of your own edits is not a filter you can trust.
       - zero is information. "Nothing targets Expert" is a fact about the
         framework worth seeing while tuning it, not an absence to hide.
       - a hidden control cannot be discovered; a dimmed one explains itself.

     Empty chips are dimmed rather than removed, and stay clickable — the empty
     state below already says "No controls match that combination" with a way
     back, so the answer is honest either way. */
  const targetCount = (lvl: Level) => fw.controls.filter((c) => c.target_level === lvl).length;
  const untargeted = fw.controls.filter((c) => c.target_level === null).length;
  const labelFor = (lvl: Level) => fw.labelOf(lvl);

  return (
    <div className="section">
      <div className="sec-head">
        <h2>Framework</h2>
        <span className="rule" />
        <span className="eyebrow">
          {fw.counts.total} controls · {fw.counts.inactive} inactive · ICB4 text is read-only
        </span>
      </div>

      <div className="filterbar">
        <span className="cap">Area</span>
        <Link className="filterchip" href={controlsHref(filter, { area: null, ce: null })}
          aria-current={!filter.area && !filter.ce ? "true" : undefined}>
          All <span className="tnum">{fw.controls.length}</span>
        </Link>
        {AREAS.map((a) => (
          <Link key={a} className="filterchip" href={controlsHref(filter, { area: a, ce: null })}
            aria-current={filter.area === a && !filter.ce ? "true" : undefined}>
            {a}{" "}
            <span className="tnum">
              {fw.controls.filter((c) => areaOfCe(c.ce_code) === a).length}
            </span>
          </Link>
        ))}
      </div>

      <div className="filterbar">
        <span className="cap">State</span>
        {([["all", "All"], ["active", "Active"], ["inactive", "Inactive"]] as const).map(
          ([value, label]) => (
            <Link key={value} className="filterchip" href={controlsHref(filter, { state: value })}
              aria-current={filter.state === value ? "true" : undefined}>
              {label}{" "}
              <span className="tnum">
                {value === "all"
                  ? fw.controls.length
                  : fw.controls.filter((c) => (value === "active" ? c.active : !c.active)).length}
              </span>
            </Link>
          ),
        )}
      </div>

      {/* Target — the reason this table exists. "Find the controls whose target
          is wrong" is the job before a cycle, and until now it meant reading a
          column down 133 rows. The chip carries the LABEL as well as the number
          because the PM picks a label and never a number (domain rule), so an
          admin comparing targets should be reading the same words they will. */}
      <div className="filterbar">
        <span className="cap">Target</span>
        <Link className="filterchip" href={controlsHref(filter, { target: null })}
          aria-current={filter.target === "all" ? "true" : undefined}>
          All <span className="tnum">{fw.controls.length}</span>
        </Link>
        {fw.scaleLevels.map((s) => {
          const n = targetCount(s.level);
          return (
            <Link key={s.level}
              className={n === 0 ? "filterchip is-empty" : "filterchip"}
              href={controlsHref(filter, { target: s.level })}
              aria-current={filter.target === s.level ? "true" : undefined}>
              <span className="tnum">{s.level}</span> {labelFor(s.level)}{" "}
              <span className="tnum">{n}</span>
            </Link>
          );
        })}
        {untargeted > 0 && (
          <Link className="filterchip" href={controlsHref(filter, { target: "none" })}
            aria-current={filter.target === "none" ? "true" : undefined}>
            No target <span className="tnum">{untargeted}</span>
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="card pad">
          <p className="note" style={{ margin: 0 }}>
            No controls match that combination. <Link href="/admin/controls">Show all {fw.counts.total}</Link>.
          </p>
        </div>
      ) : (
        <>
          {filtered && (
            <p className="note" style={{ marginTop: 0 }}>
              Showing <b className="tnum">{rows.length}</b> of{" "}
              <b className="tnum">{fw.counts.total}</b> controls.{" "}
              <Link href="/admin/controls">Clear filters</Link>
            </p>
          )}

          {groups.map((g) => (
            <div key={g.ce.code} className="card pad" style={{ marginBottom: 16 }}>
              <div className="crumb" style={{ marginBottom: 10 }}>
                <span className="area">{g.ce.area}</span>
                <span className="sep">›</span>
                <span>
                  <b className="tnum">{g.ce.code}</b> {g.ce.name}
                </span>
                <span className="sep">·</span>
                <span className="muted">
                  {g.controls.length} shown
                  {(() => {
                    const all = fw.controls.filter((c) => c.ce_code === g.ce.code).length;
                    return all === g.controls.length ? "" : ` of ${all}`;
                  })()}
                  {(() => {
                    const t = fw.data.ce_targets.find((x) => x.ce_code === g.ce.code)?.target;
                    return t == null ? "" : ` · competency target ${t}`;
                  })()}
                </span>
              </div>

              <div className="tablewrap">
                <table className="grid stacked">
                  <thead>
                    <tr>
                      <th>Control</th>
                      <th>Indicator</th>
                      <th className="num">Target</th>
                      <th>Priority</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.controls.map((c) => (
                      <tr key={c.code}>
                        <td data-label="Control">
                          {/* The filter rides along, so the editor's Previous
                              and Next walk this same view rather than all 133. */}
                          <Link className="rcode tnum" href={editorHref(c.code, filter)}>{c.code}</Link>
                        </td>
                        <td data-label="Indicator">
                          <Link href={editorHref(c.code, filter)} style={{ color: "var(--ink)" }}>
                            {c.indicator}
                          </Link>
                        </td>
                        <td data-label="Target" className="num tnum">{c.target_level ?? "—"}</td>
                        <td data-label="Priority">{c.priority ?? "—"}</td>
                        <td data-label="State">
                          {c.active
                            ? <span className="tick tick-done">Active</span>
                            : <span className="tick tick-off">Inactive</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
