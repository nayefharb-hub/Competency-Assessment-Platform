import Link from "@/app/link";
import { requireRole } from "@/lib/auth";
import { getFramework } from "@/lib/framework";

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
 * job is orientation into a lie.
 */
export default async function AdminControlsIndex({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; ce?: string; state?: string }>;
}) {
  await requireRole("admin");
  const { area: areaParam, ce: ceParam, state: stateParam } = await searchParams;
  const fw = await getFramework();

  const AREAS = ["Perspective", "People", "Practice"] as const;
  const area = AREAS.includes(areaParam as (typeof AREAS)[number]) ? areaParam : null;
  /* A competency filter only means something inside its own area, and picking
     one implies the area — so `ce` wins and the area chips reflect it. */
  const ce = fw.data.competence_elements.some((e) => e.code === ceParam) ? ceParam : null;
  const state: "all" | "active" | "inactive" =
    stateParam === "active" || stateParam === "inactive" ? stateParam : "all";

  const ceOf = (code: string) => fw.data.competence_elements.find((e) => e.code === code);
  const areaOfCe = (code: string) => ceOf(code)?.area ?? "";

  const matches = (c: (typeof fw.controls)[number]) =>
    (!ce ? (!area || areaOfCe(c.ce_code) === area) : c.ce_code === ce)
    && (state === "all" || (state === "active" ? c.active : !c.active));

  const rows = fw.controls.filter(matches);

  /* Framework order — the ICB4 sequence the standard publishes and the PMs saw
     in the workbook, not alphabetical and not database order. */
  const groups = fw.data.competence_elements
    .map((e) => ({ ce: e, controls: rows.filter((c) => c.ce_code === e.code) }))
    .filter((g) => g.controls.length > 0);

  const href = (next: { area?: string | null; ce?: string | null; state?: string | null }) => {
    const q = new URLSearchParams();
    const a = next.area === undefined ? area : next.area;
    const e = next.ce === undefined ? ce : next.ce;
    const s = next.state === undefined ? state : next.state;
    if (a) q.set("area", a);
    if (e) q.set("ce", e);
    if (s && s !== "all") q.set("state", s);
    const qs = q.toString();
    return qs ? `/admin/controls?${qs}` : "/admin/controls";
  };

  const filtered = area !== null || ce !== null || state !== "all";
  /* Which competencies the area chips should offer. Selecting an area narrows
     this list; selecting a competency from another area would be unreachable
     rather than empty, so the list follows the area. */
  const cesForPicker = fw.data.competence_elements.filter(
    (e) => !area || e.area === area,
  );

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
        <Link className="filterchip" href={href({ area: null, ce: null })}
          aria-current={!area && !ce ? "true" : undefined}>
          All <span className="tnum">{fw.controls.length}</span>
        </Link>
        {AREAS.map((a) => (
          <Link key={a} className="filterchip" href={href({ area: a, ce: null })}
            aria-current={area === a && !ce ? "true" : undefined}>
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
            <Link key={value} className="filterchip" href={href({ state: value })}
              aria-current={state === value ? "true" : undefined}>
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

      <div className="filterbar">
        <span className="cap">Competency</span>
        <Link className="filterchip" href={href({ ce: null })}
          aria-current={!ce ? "true" : undefined}>
          All
        </Link>
        {cesForPicker.map((e) => (
          <Link key={e.code} className="filterchip" href={href({ ce: e.code, area: null })}
            aria-current={ce === e.code ? "true" : undefined}>
            <span className="tnum">{e.code}</span> {e.name}
          </Link>
        ))}
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
                          <Link className="rcode tnum" href={`/admin?c=${c.code}`}>{c.code}</Link>
                        </td>
                        <td data-label="Indicator">
                          <Link href={`/admin?c=${c.code}`} style={{ color: "var(--ink)" }}>
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
