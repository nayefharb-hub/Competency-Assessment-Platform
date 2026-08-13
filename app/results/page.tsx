import Link from "@/app/link";
import { canAssess, requireUser } from "@/lib/auth";
import { ASSESS_HUB } from "@/lib/routes";
import { getFramework } from "@/lib/framework";
import {
  findAssessment, listAssessments, loadAssessment, loadForAssessee,
} from "@/lib/db/assessment";
import { rollupAll } from "@/lib/rollup";
import { gapsOf } from "@/lib/narrative";
import { CapabilityReport } from "./capability-report";
import { StrengthsGaps } from "./strengths-gaps";
import type { Assessment } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Results.
 *
 * A PM sees their own results, and only once the assessor has approved — before
 * that the authoritative scores do not exist yet. The assessor can open anyone's
 * with ?a=. Targets shown here are the ones frozen at approval (rollup-spec §6),
 * so a later change of benchmark profile cannot move a historic gap.
 *
 * The analytical body (tiles · radar · narrative · competency drill-down) is the
 * shared `CapabilityReport`, so the PMO analysis screen shows the identical
 * report beside a person's pace without a second copy of the rollup-to-markup.
 */
export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; approved?: string; view?: string }>;
}) {
  const { a: requested, approved, view } = await searchParams;
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

  const gaps = gapsOf(rollupAll(fw.data, assessment)).length;
  const initials = assessment.assessee_name.split(" ").map((w) => w[0]).join("").slice(0, 2);
  const revised = assessment.scores.filter((s) => s.assessor_touched).length;

  // Preserve ?a= (an assessor viewing someone) across the toggle, so switching
  // views never drops back to the assessor's own assessment. Only when ?a= is
  // actually in effect — the same guard the load above uses — so a PM's toggle
  // never carries a stale id the page would ignore anyway. React escapes the
  // interpolated id in the href, and an unmatched id never reaches here (it
  // returns NotYet above), so the raw param is safe to embed.
  const gapsView = view === "gaps";
  const usingRequested = Boolean(requested) && canAssess(user);
  const base = usingRequested ? `/results?a=${requested}` : "/results";
  const areaHref = base;
  const gapsHref = usingRequested ? `${base}&view=gaps` : `${base}?view=gaps`;

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

        {/* Navigation between two URLs, not in-page tab panels — so `nav` +
            `aria-current`, not role="tablist"/aria-selected (which promises a
            tabpanel that does not exist). */}
        <nav className="sgtoggle segmented" aria-label="Results view">
          <Link href={areaHref} aria-current={gapsView ? undefined : "page"}>
            By area
          </Link>
          <Link href={gapsHref} aria-current={gapsView ? "page" : undefined}>
            Strengths &amp; gaps
          </Link>
        </nav>

        {gapsView ? (
          <StrengthsGaps fw={fw} assessment={assessment} />
        ) : (
          <CapabilityReport fw={fw} assessment={assessment} />
        )}
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
