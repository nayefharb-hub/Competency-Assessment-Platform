import Link from "@/app/link";
import { getFramework } from "@/lib/framework";
import { departmentData } from "@/lib/db/assessment";
import { departmentRollup, fmtLevel } from "@/lib/rollup";
import { tidyIndicator } from "@/lib/narrative";
import { AreaRadar } from "@/app/results/area-radar";
import { HealthPill } from "@/app/results/capability-report";
import type { Assessment, AreaResult } from "@/lib/types";

/**
 * Department capability — the PMO-level view (docs/design-pmo-department-analysis.md).
 *
 * The Head of PMO looking at the whole team: who has finished, and where the
 * department is collectively strong and weak against ICB4. Every number is
 * METHOD A (the mean, over included people, of each person's own rolled-up
 * figure — see `departmentRollup`), shown with its spread and a count below
 * target so a small-team average cannot hide that a mean is really a few experts
 * carrying several novices. Approved assessments only feed the rollup; the status
 * board shows everyone. This supports a decision — it never gates one.
 */

const AREA_ORDER = ["Perspective", "People", "Practice"] as const;

const MAX = 5;
const pct = (v: number) => `${(v / MAX) * 100}%`;

function scoredCount(a: Assessment, active: Set<string>): number {
  return a.scores.filter((s) => s.self_level !== null && active.has(s.control_code)).length;
}

/** not started / in progress / completed (submitted) / approved. */
function bucketOf(a: Assessment, active: Set<string>): "notStarted" | "inProgress" | "completed" | "approved" {
  if (a.state === "approved") return "approved";
  if (a.state === "self_submitted") return "completed";
  return scoredCount(a, active) > 0 ? "inProgress" : "notStarted";
}

const STATE_LABEL: Record<string, string> = {
  approved: "Approved",
  completed: "Submitted",
  inProgress: "In progress",
  notStarted: "Not started",
};
const STATE_TIER: Record<string, string> = {
  approved: "ready",
  completed: "minor",
  inProgress: "neutral",
  notStarted: "neutral",
};

export async function DepartmentOverview({
  exclude,
  cycle,
}: {
  exclude: Set<string>;
  cycle: string;
}) {
  const fw = await getFramework();
  const { everyone, approved } = await departmentData(cycle);
  const active = new Set(fw.activeControls.map((c) => c.code));

  const included = approved.filter((a) => !exclude.has(a.id));
  const dept = departmentRollup(fw.data, included);

  // Status board buckets, over everyone assigned this cycle.
  const buckets = { notStarted: [] as Assessment[], inProgress: [] as Assessment[], completed: [] as Assessment[], approved: [] as Assessment[] };
  for (const a of everyone) buckets[bucketOf(a, active)].push(a);

  // Toggle an id in/out of ?exclude, preserving the rest.
  const toggleHref = (id: string): string => {
    const next = new Set(exclude);
    if (next.has(id)) next.delete(id); else next.add(id);
    const q = [...next];
    return q.length ? `/analysis?exclude=${q.join(",")}` : "/analysis";
  };

  // Department radar reuses the /results triangle; ce_count per area for its labels.
  const ceCountByArea = new Map<string, number>();
  for (const c of dept.ces) ceCountByArea.set(c.area, (ceCountByArea.get(c.area) ?? 0) + 1);
  const radarAreas: AreaResult[] = dept.areas.map((ar) => ({
    area: ar.area, actual: ar.actual, target: ar.target, ce_count: ceCountByArea.get(ar.area) ?? 0,
  }));

  // Name controls by their ICB4 indicator text, tidied of extraction junk —
  // never by an opaque code (DESIGN.md), the same rule and helper /results uses.
  const ctrlText = new Map(fw.data.controls.map((c) => [c.code, c.indicator ?? c.code]));
  const ctrlLabel = (code: string) => tidyIndicator(ctrlText.get(code) ?? code);

  return (
    <div className="section">
      <div className="sec-head">
        <h2>Department capability</h2>
        <span className="rule" />
        <span className="eyebrow">cycle {cycle}</span>
      </div>

      <div className="card pad" style={{ marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: "var(--fs-ui)" }}>
          The team seen as a whole. Capability figures are the <b>average of each included
          person&rsquo;s own result</b>, shown with the spread and how many people sit below
          target — a single average can hide a split between strong and developing. Only
          <b> approved</b> assessments count toward capability; everyone appears on the status
          board. This supports a decision and does not grade anyone.
        </p>
      </div>

      {/* --------------------------------------------------------- status board */}
      <div className="card pad">
        <div className="cap" style={{ marginBottom: 10 }}>WHERE EVERYONE IS · {everyone.length} assigned</div>
        <div className="tiles" style={{ marginBottom: 14 }}>
          {(["approved", "completed", "inProgress", "notStarted"] as const).map((b) => (
            <div className="tile" key={b}>
              <div className="lbl">{STATE_LABEL[b]}</div>
              <div className="big tnum">{buckets[b].length}</div>
            </div>
          ))}
        </div>
        <div className="tablewrap">
          <table className="grid stacked">
            <thead>
              <tr><th>Name</th><th>State</th><th className="num">Scored</th></tr>
            </thead>
            <tbody>
              {everyone.map((a) => {
                const b = bucketOf(a, active);
                return (
                  <tr key={a.id}>
                    <td data-label="Name">
                      {a.state === "approved"
                        ? <Link href={`/analysis?a=${a.id}`}>{a.assessee_name}</Link>
                        : a.assessee_name}
                    </td>
                    <td data-label="State">
                      <span className={`pill pill-${STATE_TIER[b]}`}><span className="dot" />{STATE_LABEL[b]}</span>
                    </td>
                    <td className="num tnum" data-label="Scored">{scoredCount(a, active)}/{active.size}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* --------------------------------------------------- include / exclude */}
      {/* Above the capability, not below it (owner, 2026-08-12): you choose who
          counts BEFORE you read the figure, so the number you see is already the
          one you meant. */}
      {approved.length > 0 && (
        <div className="card pad" style={{ marginTop: 20 }}>
          <div className="cap" style={{ marginBottom: 8 }}>INCLUDE IN THE DEPARTMENT FIGURE</div>
          <p className="note" style={{ marginTop: 0 }}>
            Choose who counts before you read the figure below — exclude anyone who would skew it,
            a leaver, a brand-new joiner, or your own self-assessment. The capability recomputes
            from who is included.
          </p>
          <ul className="picklist">
            {approved.map((a) => {
              const on = !exclude.has(a.id);
              return (
                <li key={a.id}>
                  <Link className="card pad ce-row" href={toggleHref(a.id)}>
                    <div className="ce-main">
                      <b style={{ textDecoration: on ? "none" : "line-through", opacity: on ? 1 : 0.55 }}>
                        {a.assessee_name}
                      </b>
                    </div>
                    <span className={`pill pill-${on ? "ready" : "neutral"}`}>
                      <span className="dot" />{on ? "Included" : "Excluded"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* --------------------------------------------------- per-person summary */}
      {/* At the top with the include/exclude control (owner, 2026-08-12): review
          each person and choose who counts, THEN read the department aggregate
          below. */}
      {dept.perPerson.length > 0 && (
        <div className="card pad" style={{ marginTop: 20 }}>
          <div className="cap" style={{ marginBottom: 6 }}>
            EACH PERSON · resource for the team vs. where development would help
          </div>
          <div className="tablewrap">
            <table className="grid stacked">
              <thead>
                <tr>
                  <th>Name</th>
                  {AREA_ORDER.map((a) => <th className="num" key={a}>{a.slice(0, 4)}</th>)}
                  <th>Strongest</th>
                  <th>Development</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dept.perPerson.map((p) => {
                  const areaVal = (name: string) => p.areas.find((a) => a.area === name)?.actual ?? null;
                  return (
                    <tr key={p.assessment_id}>
                      <td data-label="Name"><Link href={`/analysis?a=${p.assessment_id}`}>{p.assessee_name}</Link></td>
                      {AREA_ORDER.map((a) => (
                        <td className="num tnum" data-label={a.slice(0, 4)} key={a}>{fmtLevel(areaVal(a))}</td>
                      ))}
                      <td data-label="Strongest">{p.strongest ? p.strongest.ce_name : "—"}</td>
                      <td data-label="Development">{p.weakest ? p.weakest.ce_name : "—"}</td>
                      <td data-label=""><Link href={`/analysis?a=${p.assessment_id}`}>Open</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --------------------------------------------------- department capability */}
      <div className="card pad" style={{ marginTop: 20 }}>
        <div className="cap" style={{ marginBottom: 4 }}>DEPARTMENT CAPABILITY</div>
        {/* Denominator is the ASSIGNED base (design §3), not the approved count:
            "2 of 4 assigned" makes the coverage gap visible — the authoritative
            figure covers only the people whose reviews are in. A readable note,
            not a small-caps label, because it is the frame the numbers are read
            in (design-review, 2026-08-12). */}
        <p className="note" style={{ margin: "0 0 4px" }}>
          Averaged over <b>{included.length}</b> of {everyone.length} assigned ·{" "}
          {approved.length} approved
          {approved.length - included.length > 0 ? ` · ${approved.length - included.length} excluded` : ""}.
        </p>

        {included.length === 0 ? (
          <p className="note" style={{ margin: "8px 0 0" }}>
            {approved.length === 0
              ? "No approved assessments yet — capability appears once the Head of PMO approves the first review."
              : <>Everyone is excluded. <Link href="/analysis">Clear the exclusions</Link> to see the department figure.</>}
          </p>
        ) : (
          <>
            <div className="tiles">
              {radarAreas.map((ar) => (
                <div className="tile" key={ar.area}>
                  <div className="lbl">{ar.area} · {ar.ce_count} elements</div>
                  <div className="big tnum">{fmtLevel(ar.actual)}<small> / {fmtLevel(ar.target)}</small></div>
                </div>
              ))}
            </div>

            <AreaRadar areas={radarAreas} />

            {/* Grouped by area under navy section headers, with the signature
                bar-on-bar mark per competency — the same language as /results
                (DESIGN.md capability list), so the two screens read alike. The
                department-specific distribution (spread · N below target) rides
                on the meta line under the name, where /results names its weakest
                control. `dept.ces` is already sorted most-serious-first, so
                filtering by area keeps that order within each section. */}
            <div className="cap" style={{ margin: "18px 0 6px" }}>
              BY COMPETENCE ELEMENT · grouped by area · most serious first · department mean vs target
            </div>
            {AREA_ORDER.map((area) => {
              const rows = dept.ces.filter((c) => c.area === area);
              const ar = radarAreas.find((a) => a.area === area);
              if (rows.length === 0) return null;
              return (
                <section className="cesection" key={area}>
                  <div className="cehead">
                    <h4>{area}</h4>
                    <span className="cehead-val tnum">
                      {fmtLevel(ar?.actual ?? null)} <span className="muted">/ {fmtLevel(ar?.target ?? null)}</span>
                    </span>
                  </div>
                  {rows.map((c) => (
                    <div className="barrow" key={c.ce_code}>
                      <div className="name">
                        {c.ce_name}
                        <small>
                          spread {c.spread ? `${fmtLevel(c.spread.min)}–${fmtLevel(c.spread.max)}` : "—"}
                          {" · "}<b className="tnum">{c.below}</b> of <span className="tnum">{c.n}</span> below target
                        </small>
                      </div>
                      <div className="track">
                        {c.target !== null && <div className="target" style={{ left: pct(c.target) }} />}
                        {c.actual !== null && c.health && (
                          <div className={`actual ${c.health}`} style={{ width: pct(c.actual) }} />
                        )}
                      </div>
                      <div className="val">
                        <b className="tnum">{fmtLevel(c.actual)}</b>{" "}
                        <span className="muted tnum">/ {fmtLevel(c.target)}</span>{" "}
                        <HealthPill health={c.health} />
                      </div>
                    </div>
                  ))}
                </section>
              );
            })}

            {dept.escalations.length > 0 && (
              <p className="note" style={{ marginTop: 12 }}>
                <b>Individual escalations</b> (someone 2+ levels below a control&rsquo;s own target):{" "}
                {dept.escalations.slice(0, 6).map((e, i) => (
                  <span key={e.control_code}>
                    {i > 0 ? " · " : ""}
                    “{ctrlLabel(e.control_code)}” ({e.count} {e.count === 1 ? "person" : "people"})
                  </span>
                ))}
                . These sit inside a person, not the department mean — open the person to see them.
              </p>
            )}
          </>
        )}
      </div>

    </div>
  );
}
