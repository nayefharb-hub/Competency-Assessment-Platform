import { framework } from "@/lib/framework";
import { demoAssessment } from "@/lib/demo";
import { fmtLevel, HEALTH_LABEL, rollupAll, rollupAreas, sortByGap } from "@/lib/rollup";
import type { CeResult, Health } from "@/lib/types";

export const dynamic = "force-static";

const MAX = 5;
const pct = (v: number) => `${(v / MAX) * 100}%`;

function HealthPill({ health }: { health: Health | null }) {
  if (!health) return <span className="muted">—</span>;
  return (
    <span className={`pill pill-${health}`}>
      <span className="dot" />
      {HEALTH_LABEL[health]}
    </span>
  );
}

function Bar({ r }: { r: CeResult }) {
  return (
    <div className="barrow">
      <div className="name">
        {r.ce_name}
        <small>
          {r.ce_code}
          {r.weakest && ` · weakest ${r.weakest.control_code} (${r.weakest.level})`}
        </small>
      </div>
      <div className="track">
        {r.target !== null && <div className="target" style={{ left: pct(r.target) }} />}
        {r.actual !== null && r.health && (
          <div className={`actual ${r.health}`} style={{ width: pct(r.actual) }} />
        )}
      </div>
      <div className="val">
        <b className="tnum">{fmtLevel(r.actual)}</b>{" "}
        <span className="muted tnum">/ {r.target ?? "—"}</span>{" "}
        <HealthPill health={r.health} />
      </div>
    </div>
  );
}

export default function ResultsPage() {
  const a = demoAssessment;
  const results = rollupAll(framework, a);
  const areas = rollupAreas(results);
  const sorted = sortByGap(results);
  const initials = a.assessee_name.split(" ").map((w) => w[0]).join("").slice(0, 2);
  const gaps = results.filter((r) => r.health === "minor" || r.health === "deficit").length;

  return (
    <div className="section">
      <div className="card pad">
        <div className="who">
          <div className="av" aria-hidden="true">{initials}</div>
          <div style={{ flex: 1 }}>
            <h3>
              {a.assessee_name} — {a.assessee_role}
            </h3>
            <div className="sub">
              Assessment cycle {a.cycle} · Benchmark: {a.profile} · Assessor: Head of PMO ·
              Status: {a.state === "approved" ? "Approved" : a.state}
            </div>
          </div>
          <span className="pill pill-minor">
            <span className="dot" />
            {gaps} gaps to close
          </span>
        </div>

        <div className="tiles">
          {areas.map((ar) => {
            const health: Health =
              ar.actual === null || ar.target === null
                ? "minor"
                : ar.actual >= ar.target
                  ? "ready"
                  : ar.target - ar.actual <= 0.5
                    ? "minor"
                    : "deficit";
            const width =
              ar.actual === null || ar.target === null || ar.target === 0
                ? "0%"
                : `${Math.min(100, (ar.actual / ar.target) * 100)}%`;
            return (
              <div className="tile" key={ar.area}>
                <div className="lbl">
                  {ar.area} · {ar.ce_count} elements
                </div>
                <div className="big tnum">
                  {fmtLevel(ar.actual)}
                  <small> / {fmtLevel(ar.target)}</small>
                </div>
                <div className="mini">
                  <i style={{ width, background: `var(--${health})` }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="cap" style={{ marginBottom: 6 }}>
          CAPABILITY BY COMPETENCE ELEMENT · sorted by gap · actual vs target on 0–5
        </div>
        {sorted.map((r) => (
          <Bar key={r.ce_code} r={r} />
        ))}

        <div className="scaleline">
          <div />
          <div className="ticks">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
          <div />
        </div>

        <div className="legend">
          <span>
            <i style={{ background: "var(--ready)" }} />
            Role Ready
          </span>
          <span>
            <i style={{ background: "var(--minor)" }} />
            Minor Gap
          </span>
          <span>
            <i style={{ background: "var(--deficit)" }} />
            Capability Deficit
          </span>
          <span>
            <i style={{ background: "var(--ink)", opacity: 0.6 }} />
            Target
          </span>
        </div>

        <p className="note" style={{ marginTop: 14 }}>
          Actual is the mean of approved scores across each element’s active controls; the
          weakest control is shown alongside so a single serious gap is not absorbed by the
          average. This report supports a decision — it does not approve, reject or gate one.
        </p>
      </div>
    </div>
  );
}
