import Link from "next/link";
import { canAdmin, canAssess, requireUser } from "@/lib/auth";
import { getFramework } from "@/lib/framework";
import {
  currentCycle, findArchivedAssessment, findAssessment, loadForAssessee,
} from "@/lib/db/assessment";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const { denied } = await searchParams;
  const user = await requireUser();
  const fw = await getFramework();
  // An assessment exists only when an admin has assigned one (N7), so this is a
  // plain read and "no row" is a real, expected state rather than a first visit.
  const row = await findAssessment(user.id);
  const mine = row ? await loadForAssessee(user, row.id) : null;
  const archived = row ? null : await findArchivedAssessment(user.id);

  const scored = mine?.scores.filter((s) => s.self_level !== null).length ?? 0;
  const total = fw.activeControls.length;
  const cycle = currentCycle();

  return (
    <div className="section">
      {denied && (
        <div className="banner banner-warn" role="status">
          That area is restricted to the Head of PMO.
        </div>
      )}

      <div className="card pad">
        <h2 style={{ fontSize: 22, fontWeight: 680, marginBottom: 6 }}>
          Assess project managers against ICB4
        </h2>
        <p className="note" style={{ fontSize: 14 }}>
          {fw.data.framework} · {fw.counts.active} active controls across {fw.counts.ces} competence
          elements · rated on the {fw.scale.name} ({fw.scale.axis} axis).
        </p>
        {!mine && (
          <p className="note" style={{ fontSize: 14, marginTop: 10 }}>
            {archived ? (
              <>
                Your {cycle} assessment was withdrawn by the Head of PMO.{" "}
                <Link href="/assess/controls">See what that means</Link>.
              </>
            ) : (
              <>
                No assessment has been assigned to you for the {cycle} cycle
                {canAdmin(user) ? " — assign one from People." : "."}
              </>
            )}
          </p>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
          {mine && (
            <Link className="btn btn-primary" href="/assess/controls">
              {mine.state === "draft"
                ? scored === 0
                  ? "Start self-assessment"
                  : `Continue self-assessment (${scored}/${total})`
                : "View your assessment"}
            </Link>
          )}
          <Link className="btn btn-secondary" href="/results">View results</Link>
          {canAdmin(user) && (
            <Link className="btn btn-secondary" href="/admin/people">People &amp; assignment</Link>
          )}
          {canAssess(user) && (
            <Link className="btn btn-secondary" href="/review">Review &amp; approve</Link>
          )}
          {canAdmin(user) && (
            <Link className="btn btn-secondary" href="/admin">Framework admin</Link>
          )}
        </div>
      </div>

      <div className="tiles" style={{ marginTop: 20 }}>
        <div className="card tile">
          <div className="lbl">Controls</div>
          <div className="big tnum">{fw.counts.active}<small> / {fw.counts.total}</small></div>
          <div className="note" style={{ marginTop: 8 }}>
            {fw.counts.inactive} inactive, excluded from every rollup
          </div>
        </div>
        <div className="card tile">
          <div className="lbl">Competence elements</div>
          <div className="big tnum">{fw.counts.ces}</div>
          <div className="note" style={{ marginTop: 8 }}>
            {(["Perspective", "People", "Practice"] as const)
              .map((a) => `${a} ${fw.data.competence_elements.filter((c) => c.area === a).length}`)
              .join(" · ")}
          </div>
        </div>
        <div className="card tile">
          <div className="lbl">Measures</div>
          <div className="big tnum">{fw.counts.measures}</div>
          <div className="note" style={{ marginTop: 8 }}>Reference only — never scored</div>
        </div>
      </div>
    </div>
  );
}
