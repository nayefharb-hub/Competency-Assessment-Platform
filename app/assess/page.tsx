import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "@/app/link";
import { requireUser } from "@/lib/auth";
import { ASSESS_HUB } from "@/lib/routes";
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
  /* An addressless /assess is not a screen, it is a question — "where was I?"
     — and the hub is where that is answered now (D30). Bookmarks and typed
     URLs land here; the menu no longer does.

     Placed before the fetch below on purpose: a redirected request pays for
     neither the framework nor the assessment, so the no-parameter path costs
     less than it did. The per-journey cost is a different question and it went
     UP — nav click, redirect, hub render, then a human click to get here,
     where it used to be one render. That is the click D30 accepted, recorded
     rather than claimed away. */
  if (!c) redirect(ASSESS_HUB);
  // The row and its scores in one request. This screen renders nothing from the
  // person, the profile or the target snapshot, and a PM loads it 132 times.
  const [fw, mine] = await Promise.all([getAssesseeFramework(), findAssessmentWithScores(user)]);
  if (!mine) {
    // Distinguish "never assigned" from "yours was archived" — see NotAssigned.
    const archived = await findArchivedAssessment(user.id);
    return <NotAssigned cycle={currentCycle()} archived={archived} />;
  }
  const { row, scores } = mine;

  /* Where an `?c=` naming an unknown or inactive control lands (D12, revised).
     An ADDRESSLESS /assess no longer reaches this code at all — it redirected
     to the hub above — and the menu no longer points here either. What is left
     is the narrower case of a stale bookmark or a hand-typed code.

     The rule itself is unchanged: return the PM to the control they were last
     on, including one they had gone back to re-read, which "first unanswered"
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
  // (The old `!c` bail-out to /assess/controls lived here. It is unreachable
  // now that an addressless /assess redirects to the hub above, and the hub
  // owns that decision for every state including "everything is answered".)
  const code = c && fw.controlByCode(c)?.active
    ? c
    : (resume ?? fw.activeControls[0].code);
  const control = fw.controlByCode(code)!;
  const ce = fw.ceOf(control.ce_code);
  const measures = fw.measuresFor(code);
  const pos = fw.controlPosition(code);
  const { prev, next } = fw.neighbours(code);

  /* What sits at the end of a competence element (D25, revised by N32). A CE is
     still the sitting and finishing it is still a moment — but the moment now
     happens IN PLACE, and Continue carries the run into the next competency
     rather than ejecting the PM to a list 28 times per assessment. `nextAfter`
     reports counts and never decides completeness; the client adds the answers
     the server has not seen. shapeOf() derives all of it in memory from data
     already fetched — no extra round trip on the path two PRs were spent
     making fast. */
  const areas = shapeOf(fw.activeControls, fw.ceOf, fw.data.measures, new Set(scored),
    fw.data.areas.map((a) => a.name));
  const milestone = nextAfter(areas, control);

  /* The recap needs the PM's answers for the competency that just ended. No new
     query: findAssessmentWithScores already returned every score for the
     assessment in one embedded select, so this is a lookup over data in hand.

     Built only when there IS a milestone. `nextAfter` returns null for every
     control that is not last-in-CE — 104 of the 132 — so without the guard four
     of five loads of this route allocated a 132-entry array and a 132-entry Map
     and then read nothing out of either. */
  const ceLevels: Record<string, number | null> = {};
  if (milestone) {
    const byCode = new Map(scores.map((s) => [s.control_code, s.self_level ?? null]));
    for (const c of milestone.controls) ceLevels[c.code] = byCode.get(c.code) ?? null;
  }

  /* E4 — where the PM is inside THIS competency, so the nearest natural
     stopping point is always visible. Same in-memory shape, no extra cost. */
  const here = areas.find((a) => a.name === control.area)?.ces
    .find((c) => c.code === control.ce_code);
  const ceProgress = here
    ? {
        /* POSITION, not answered-count. "3 of 5 in this competency" has to mean
           "you are on the third of five", which is what tells a PM how far the
           nearest stopping point is. An answered-count would jump around when
           they skip, and read as progress they have not made.

           The name and code are NOT carried here — the heading below renders
           them from `fw.ceOf`, and two sources for one fact is the defect this
           whole change set exists to remove. */
        position: here.controls.findIndex((c) => c.code === control.code) + 1,
        total: here.controls.length,
      }
    : null;

  const score = scores.find((s) => s.control_code === code);
  const locked = row.state !== "draft";

  return (
    <div className="section assess-wide">
      <div className="assess-nav">
        <Link className="btn btn-secondary btn-sm" href={`/assess/area/${encodeURIComponent(control.area)}`}>
          ← {control.area}
        </Link>
        {/* "N scored so far" used to sit here. It was dropped when the
            milestone stopped navigating: this line is rendered by the server,
            the milestone now appears without a navigation, and the save action
            deliberately calls no revalidatePath — so the count sat one behind
            reality, on screen, directly above a card announcing the competency
            was complete. The competency-scoped "3 of 5" added below does the
            orientation job better and locally, and the assessment-wide count
            still leads the hub and the controls list, which are the screens
            whose job is reporting progress. */}
        <span className="note">
          Control <b className="tnum">{pos}</b> of{" "}
          <b className="tnum">{fw.activeControls.length}</b> · you can jump back to any control
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
          {/* N31 — the competency was the least visible thing on this screen,
              which is backwards: it is the unit the rollup aggregates into and
              the unit a PM has to calibrate against ("am I proficient at
              THIS?"). It now leads, at heading weight, with the area and the
              control code demoted to the line above and below it. */}
          <div className="crumb">
            <span className="area">{control.area}</span>
            <span className="sep">›</span>
            <span>
              Control <b>{control.code}</b>
            </span>
          </div>

          <p className="ce-name">
            <span className="tnum">{ce?.code}</span> {ce?.name}
            {ceProgress && (
              /* E4 — how far the nearest natural stopping point is. A PM who
                 can see the end of the current stretch does not need to be
                 ejected to a list to feel one. */
              <span className="ce-progress">
                <b className="tnum">{ceProgress.position}</b>
                {" of "}
                <b className="tnum">{ceProgress.total}</b> in this competency
              </span>
            )}
          </p>

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
            milestone={milestone}
            ceLevels={ceLevels}
          />
        </div>
      </div>
    </div>
  );
}
