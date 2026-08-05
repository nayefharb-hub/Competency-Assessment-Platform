import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "@/app/link";
import { requireUser } from "@/lib/auth";
import { getAssesseeFramework } from "@/lib/framework";
import {
  currentCycle, findArchivedAssessment, findAssessmentWithScores,
} from "@/lib/db/assessment";
import { nextAfter, scoredCodes, shapeOf } from "@/lib/shape";
import NotAssigned from "./not-assigned";
import ScorePanel from "./score-panel";

export const dynamic = "force-dynamic";

/**
 * PM self-assessment — one control at a time, persisted to Supabase.
 *
 * The framework arrives through getAssesseeFramework(), which has already
 * stripped the target, priority, reason and kib_note. Blinding the PM to the
 * target is methodology, not decoration: seeing it anchors the self-score.
 *
 * LAYOUT (N14): ICB4 prose on the left, the scoring panel on the right and
 * pinned. The two are separate cards because they are separate jobs — read the
 * indicator, then answer — and because a pinned panel has to be able to stay
 * put while the prose beside it scrolls. The longest indicator in ICB4 runs to
 * 2,596 characters and is never edited, so no layout makes every control fit a
 * laptop screen; what this one guarantees is that the answer and Save never
 * leave it. Below 1100px it collapses to one column with the actions pinned.
 */
export default async function AssessPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; error?: string }>;
}) {
  const { c, error } = await searchParams;
  const user = await requireUser();
  // The row and its scores in one request. This screen renders nothing from the
  // person, the profile or the target snapshot, and a PM loads it 132 times.
  const [fw, mine] = await Promise.all([getAssesseeFramework(), findAssessmentWithScores(user)]);
  if (!mine) {
    // Distinguish "never assigned" from "yours was archived" — see NotAssigned.
    const archived = await findArchivedAssessment(user.id);
    return <NotAssigned cycle={currentCycle()} archived={archived} />;
  }
  const { row, scores } = mine;

  /* Where an unaddressed /assess lands (decision D12, revised by the owner).
     The menu used to open control 1 every time, so a PM sixty controls in had
     to find their own place. It now returns them to the control they were last
     on — including one they had gone back to re-read, which "first unanswered"
     would have overruled.

     The position is a cookie: a per-device convenience, not part of the
     assessment record, and the same argument DESIGN.md makes for the theme.
     Read here so the right control renders on the first pass — no flash, no
     client redirect. First unanswered is the fallback when there is no cookie
     (new device, cleared browser), which is also the sensible answer for
     someone starting out. */
  const scored = new Set(
    scores.filter((s) => s.self_level !== null).map((s) => s.control_code),
  );
  const firstUnanswered = fw.activeControls.find((ac) => !scored.has(ac.code));
  const remembered = (await cookies()).get("cap.last")?.value;
  const resume = (remembered && fw.controlByCode(remembered)?.active ? remembered : null)
    ?? firstUnanswered?.code;
  if (!c && !resume && row.state === "draft") redirect("/assess/controls");
  const code = c && fw.controlByCode(c)?.active
    ? c
    : (resume ?? fw.activeControls[0].code);
  const control = fw.controlByCode(code)!;
  const ce = fw.ceOf(control.ce_code);
  const measures = fw.measuresFor(code);
  const pos = fw.controlPosition(code);
  const { prev, next } = fw.neighbours(code);

  /* Where "Next" goes at the end of a competence element (D25). A CE is the
     sitting, so its last control does not walk into the next CE's first —
     finishing is a moment, and continuing is a choice. The last CE of an area
     steps up one further. shapeOf() derives this in memory from data already
     fetched; no extra round trip on the path two PRs were spent making fast. */
  const areas = shapeOf(fw.activeControls, fw.ceOf, fw.data.measures, scoredCodes(scores));
  const boundary = nextAfter(areas, control);

  const score = scores.find((s) => s.control_code === code);
  const answered = scores.filter((s) => s.self_level !== null).length;
  const locked = row.state !== "draft";

  return (
    <div className="section assess-wide">
      <div className="assess-nav">
        <Link className="btn btn-secondary btn-sm" href={`/assess/area/${encodeURIComponent(control.area)}`}>
          ← {control.area}
        </Link>
        <span className="note">
          Control <b className="tnum">{pos}</b> of{" "}
          <b className="tnum">{fw.activeControls.length}</b> ·{" "}
          <b className="tnum">{answered}</b> scored so far · you can jump back to any control
        </span>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {locked && (
        <div className="banner banner-warn" role="status">
          You submitted this assessment on{" "}
          {row.submitted_at?.slice(0, 10) ?? "submission"} — it is with the
          Head of PMO now, so scores can no longer be changed.
        </div>
      )}

      <div className="assess-grid">
        {/* ---- what the control asks: ICB4 source text, capped at --measure ---- */}
        <div className="card pad">
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

          <h2 style={{ fontSize: 17, fontWeight: 650, marginBottom: 2 }}>{control.indicator}</h2>
          {control.description && (
            <p className="lede" style={{ margin: "8px 0 0", fontSize: 15 }}>
              {control.description}
            </p>
          )}

          {measures.length > 0 && (
            <>
              <div className="mh">
                Measures — what “doing this” looks like{" "}
                <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                  (reference only, not scored)
                </span>
              </div>
              <ul className="measures">
                {measures.map((m) => (
                  <li key={`${m.control_code}-${m.no}`}>{m.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        {/* ---- your answer: pinned, so it never scrolls out of reach ----
             A client component since the save UX change: the answer is held
             locally until "Next control" commits it to the outbox, so the PM
             never waits on a write (docs/eng-plan-save-ux.md). */}
        <div className="scorepanel">
          <ScorePanel
            control={code}
            nextControl={next?.code ?? null}
            prevControl={prev?.code ?? null}
            levels={fw.scaleLevels.map((s) => ({
              level: s.level,
              label: s.label,
              gloss: fw.glossOf(s.level),
            }))}
            savedLevel={score?.self_level ?? null}
            savedEvidence={score?.evidence ?? ""}
            locked={locked}
            boundary={boundary}
          />
        </div>
      </div>
    </div>
  );
}
