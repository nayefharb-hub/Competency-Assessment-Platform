import { notFound } from "next/navigation";
import Link from "@/app/link";
import { requireUser } from "@/lib/auth";
import { ASSESS_HUB } from "@/lib/routes";
import { getAssesseeFramework } from "@/lib/framework";
import {
  currentCycle, findArchivedAssessment, findAssessmentWithScores,
} from "@/lib/db/assessment";
import { estimateLabel } from "@/lib/duration";
import { scoredCodes, shapeOf } from "@/lib/shape";
import NotAssigned from "../../not-assigned";

export const dynamic = "force-dynamic";

/**
 * One area's competence elements — the list a PM picks a sitting from.
 *
 * Each row is 3-6 controls and about five minutes, which is the whole point:
 * "score Strategy" is a thing someone decides to do on a Tuesday, where "score
 * 132 controls" is a thing they postpone.
 *
 * As with the areas screen, targets are absent by construction
 * (getAssesseeFramework) and asserted absent by e2e.
 */
export default async function AreaPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  // Next already percent-decodes dynamic segments. Decoding again mangles any
  // name containing a literal % and throws URIError on a hand-typed /%zz,
  // turning an intended notFound() into a 500.
  const areaName = name;
  const user = await requireUser();
  const [fw, mine] = await Promise.all([getAssesseeFramework(), findAssessmentWithScores(user)]);
  if (!mine) {
    const archived = await findArchivedAssessment(user.id);
    return <NotAssigned cycle={currentCycle()} archived={archived} />;
  }

  const done = scoredCodes(mine.scores);
  const areas = shapeOf(fw.activeControls, fw.ceOf, fw.data.measures, done,
    fw.data.areas.map((a) => a.name));
  const area = areas.find((a) => a.name === areaName);
  if (!area) notFound();

  return (
    <div className="section">
      <div className="assess-nav">
        <Link className="btn btn-secondary btn-sm" href={ASSESS_HUB}>← All areas</Link>
        <span className="note">
          <b className="tnum">{area.scored}</b> of <b className="tnum">{area.controls}</b> controls scored
          {area.scored < area.controls && <> · {estimateLabel(area.estimate)} remaining in full</>}
        </span>
      </div>

      <h2 style={{ fontSize: 22, fontWeight: 680, margin: "0 0 4px" }}>{area.name}</h2>
      <p className="lede" style={{ margin: "0 0 16px" }}>
        {area.ces.length} competencies. Each is a few controls — about five minutes — so you can
        finish one and stop.
      </p>

      <div className="ce-list">
        {area.ces.map((ce) => {
          const complete = ce.scored === ce.controls.length;
          const target = ce.firstUnscored ?? ce.controls[0];
          return (
            <Link
              key={ce.code}
              className={`card pad ce-row${complete ? " ce-done" : ""}`}
              href={`/assess?c=${target.code}`}
            >
              <div className="ce-main">
                <b>{ce.code} {ce.name}</b>
                <span className="note">
                  <b className="tnum">{ce.controls.length}</b> controls
                  {!complete && <> · {estimateLabel(ce.estimate)}</>}
                </span>
              </div>
              <span className={complete ? "pill pill-ready" : "note tnum"}>
                {complete ? "✓ complete" : `${ce.scored} / ${ce.controls.length}`}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
