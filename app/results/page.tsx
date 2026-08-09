import Link from "@/app/link";
import { canAssess, requireUser } from "@/lib/auth";
import { ASSESS_HUB } from "@/lib/routes";
import { getFramework } from "@/lib/framework";
import {
  findAssessment, listAssessments, loadAssessment, loadForAssessee,
} from "@/lib/db/assessment";
import { fmtLevel, healthOf, HEALTH_LABEL, rollupAll, rollupAreas, sortByGap } from "@/lib/rollup";
import type { Assessment, CeResult, Health } from "@/lib/types";

export const dynamic = "force-dynamic";

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

/**
 * Why a CE can read "Capability Deficit" while its mean sits at or above target:
 * one control 2+ levels below its own target escalates the whole element
 * (rollup-spec §4). Without this line the screen shows 3.0 / 3 next to a deficit
 * badge and looks broken — the number and the verdict appear to disagree, and
 * the reader has no way to find the control responsible.
 *
 * Shown ONLY when escalation actually changed the verdict. When the mean is also
 * more than half a level short the badge needs no defence, and explaining it
 * anyway would train people to skim past the line in the case that matters.
 */
function escalationNote(r: CeResult): string | null {
  if (!r.escalation_drove_health || r.escalated_by.length === 0) return null;
  const [first, ...rest] = r.escalated_by;
  const more = rest.length === 0 ? "" : ` and ${rest.length} more`;
  return ` · deficit driven by ${first.control_code}, scored ${first.level} against target ${first.target}${more}`;
}

function Bar({ r }: { r: CeResult }) {
  return (
    <div className="barrow">
      <div className="name">
        {r.ce_name}
        <small>
          {r.ce_code}
          {r.weakest && ` · weakest ${r.weakest.control_code} (${r.weakest.level})`}
          {escalationNote(r)}
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
        <span className="muted tnum">/ {fmtLevel(r.target)}</span>{" "}
        <HealthPill health={r.health} />
      </div>
    </div>
  );
}

/**
 * Results.
 *
 * A PM sees their own results, and only once the assessor has approved — before
 * that the authoritative scores do not exist yet. The assessor can open anyone's
 * with ?a=. Targets shown here are the ones frozen at approval (rollup-spec §6),
 * so a later change of benchmark profile cannot move a historic gap.
 */
export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; approved?: string }>;
}) {
  const { a: requested, approved } = await searchParams;
  const user = await requireUser();
  const fw = await getFramework();

  let assessment: Assessment | null;
  if (requested && canAssess(user)) {
    assessment = await loadAssessment(requested);
  } else {
    // read-only: never create a row just because someone looked at results
    const row = await findAssessment(user.id);
    assessment = row ? await loadForAssessee(user, row.id) : null;
  }

  if (!assessment || assessment.state !== "approved") {
    return <NotYet assessment={assessment} canPick={canAssess(user)} />;
  }

  const results = rollupAll(fw.data, assessment);
  const areas = rollupAreas(results);
  const sorted = sortByGap(results);
  const initials = assessment.assessee_name.split(" ").map((w) => w[0]).join("").slice(0, 2);
  const gaps = results.filter((r) => r.health === "minor" || r.health === "deficit").length;
  const revised = assessment.scores.filter((s) => s.assessor_touched).length;

  return (
    <div className="section">
      {approved && (
        <div className="banner banner-ok" role="status">
          Approved. Targets are frozen at these values for this cycle.
        </div>
      )}
      <div className="card pad">
        <div className="who">
          <div className="av" aria-hidden="true">{initials}</div>
          {/* class, not an inline style — inline wins over the mobile rule */}
          <div className="whobody">
            <h3>
              {assessment.assessee_name} — {assessment.assessee_role}
            </h3>
            <div className="sub">
              Assessment cycle {assessment.cycle} · Approved
              {assessment.approved_at ? ` ${assessment.approved_at.slice(0, 10)}` : ""} ·{" "}
              {revised} control{revised === 1 ? "" : "s"} revised by the assessor
            </div>
          </div>
          <span className="pill pill-minor">
            <span className="dot" />
            {gaps} gaps to close
          </span>
        </div>

        <div className="tiles">
          {areas.map((ar) => {
            /*
             * The SAME healthOf the CE rows use (rollup-spec §4: the thresholds
             * are defined in exactly one place). This was an inlined copy of the
             * three tiers with a bare `<= 0.5`, and it survived the 2026-08-08
             * change that put an epsilon on the real one — leaving the copy MORE
             * exposed than the original, because an area figure is a mean of
             * means over 5, 10 and 13 competencies whose own denominators are
             * 3-6. Five CEs at target 14/6 against actual 11/6 gives a gap of
             * 0.5000000000000002 and painted the deficit colour on an area
             * exactly half a level short.
             *
             * Areas have no health of their own (§5) — this only picks a bar
             * colour, so a null rolls up to "minor" exactly as before.
             */
            const health: Health = healthOf(ar.actual, ar.target, false) ?? "minor";
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

async function NotYet({
  assessment,
  canPick,
}: {
  assessment: Assessment | null;
  canPick: boolean;
}) {
  const others = canPick ? (await listAssessments()).filter((a) => a.state === "approved") : [];
  return (
    <div className="section">
      <div className="card pad">
        <h2 style={{ fontSize: "1.125rem", fontWeight: 650, marginBottom: 6 }}>
          Results are not available yet
        </h2>
        <p className="note">
          {!assessment ? (
            <>
              No assessment has been assigned to you for this cycle, so there is nothing to
              report yet. The Head of PMO assigns each cycle.
            </>
          ) : assessment.state === "draft" ? (
            <>
              Your self-assessment is still in progress.{" "}
              <Link href={ASSESS_HUB}>Pick up where you left off</Link>. Results appear
              once the Head of PMO has reviewed and approved your scores.
            </>
          ) : (
            <>
              Submitted{assessment?.submitted_at ? ` on ${assessment.submitted_at.slice(0, 10)}` : ""} and
              waiting for the Head of PMO to review. Your results appear here as soon as the
              review is approved.
            </>
          )}
        </p>

        {canPick && others.length > 0 && (
          <>
            <div className="cap" style={{ margin: "18px 0 6px" }}>APPROVED ASSESSMENTS</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {others.map((a) => (
                <li key={a.id} style={{ fontSize: "var(--fs-ui)" }}>
                  <Link href={`/results?a=${a.id}`}>{a.assessee_name}</Link> · cycle {a.cycle}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
