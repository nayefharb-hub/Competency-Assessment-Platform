import Link from "@/app/link";
import { requireUser } from "@/lib/auth";
import { getAssesseeFramework, getFramework } from "@/lib/framework";
import {
  currentCycle, findAssessment, listAssessments, loadAssessment, paceFor,
} from "@/lib/db/assessment";
import { paceLabel, summarise, summariseByCe, type PaceSummary } from "@/lib/pace";

export const dynamic = "force-dynamic";

/**
 * Pace analysis — how an assessment was filled in, not what it said (D22/D28).
 *
 * WHO SEES WHAT, and why it is not the usual requireRole() one-liner:
 *
 *   assessor / admin  → any assessment in the cycle
 *   assessee          → their own, and ONLY their own
 *
 * The second rule is the load-bearing one. `?a=` names an assessment id, so a
 * PM who edits the query string is one guess away from reading a colleague's
 * behaviour if the route trusts the parameter. It does not: for an assessee the
 * parameter is ignored entirely and the assessment is resolved from the
 * session, which is the same rule the scoring path uses and for the same
 * reason.
 *
 * A PM CAN see their own (D21). Nothing here is hidden from the person it
 * describes — a measurement of someone's working that they are not allowed to
 * look at is a trap, and this one is meant to be an instrument.
 *
 * NO TARGETS REACH THIS SCREEN, and — the part a review pass had to correct —
 * that is enforced by which framework reader the assessee branch CALLS, not by
 * what this component happens to render. The first version loaded
 * `getFramework()` for both branches, which put every `target_level`,
 * `kib_note` and benchmark in scope on a PM's render. Nothing displayed them,
 * which is exactly the condition the earlier review named as disqualifying on
 * `/`: safe by what it renders rather than by what it is allowed to touch. One
 * future "helpful" Target column in the table below would have leaked
 * anchoring data with no crash, no failing test and no review signal — and the
 * e2e guard could not have caught it, because it checks rendered output.
 *
 * So the assessee branch reads `getAssesseeFramework()` (targets nulled) and
 * only staff get the full one.
 */
export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string | string[] }>;
}) {
  const { a: rawA } = await searchParams;
  // `?a=x&a=y` arrives as an ARRAY. Casting it to string let it reach
  // `.eq("id", [...])`, which PostgREST renders as `id=eq.x,y` and Postgres
  // rejects as a malformed uuid — a 500 with a database message in it, from a
  // query string anyone can type.
  const a = Array.isArray(rawA) ? rawA[0] : rawA;
  const user = await requireUser();
  const staff = user.role === "assessor" || user.role === "admin";

  if (staff && !a) return <Picker />;

  // An assessee's own assessment comes from the SESSION. `a` is not consulted.
  //
  // The two branches also differ in WHICH READER they use, deliberately.
  // `loadAssessment` assembles the full record including the target snapshot;
  // that is fine for staff and wrong for an assessee, whose screens must not
  // hold targets at all (D24). The review pass found `/` "safe by what it
  // happens to render rather than by what it is allowed to touch" and called
  // that a latent leak. Not repeating it here: the assessee branch reads the
  // bare row, which has no targets on it to leak.
  const own = staff ? null : await findAssessment(user.id);
  const assessmentId = staff ? (a as string) : own?.id ?? null;

  if (!assessmentId) return <NothingToAnalyse />;

  const [fw, staffRecord, scores] = await Promise.all([
    // See the note above: the reader IS the boundary. This page needs only
    // code/name/ce_code/indicator/description/active, all of which survive
    // redaction, so the assessee branch gives up nothing by taking it.
    staff ? getFramework() : getAssesseeFramework(),
    // An id that names nothing — a bookmark to a record since archived, or a
    // typo — must be an empty screen, not a stack trace with a database
    // message in it. loadAssessment throws on a miss, so it is caught here
    // rather than left to the error boundary.
    staff ? loadAssessment(assessmentId).catch(() => null) : Promise.resolve(null),
    paceFor(assessmentId).catch(() => []),
  ]);
  if (staff && !staffRecord) return <NothingToAnalyse unknown />;
  const who = staffRecord?.assessee_name ?? user.full_name;
  const cycle = staffRecord?.cycle ?? own?.cycle ?? currentCycle();

  const summary = summarise(scores, fw.activeControls);
  const byCe = summariseByCe(
    scores, fw.activeControls, fw.data.competence_elements.map((c) => c.code),
  );
  const ceName = new Map(fw.data.competence_elements.map((c) => [c.code, c.name]));

  return (
    <div className="section">
      <div className="sec-head">
        <h2>{staff ? `How ${who} worked` : "How your assessment is going"}</h2>
        <span className="rule" />
        <span className="eyebrow">cycle {cycle}</span>
      </div>

      {staff && (
        <p className="note" style={{ marginTop: -6, marginBottom: 14 }}>
          <Link href="/analysis">← everyone</Link>
        </p>
      )}

      {/* Said first, before any number, because it is the frame the numbers
          have to be read in. The tool supports a decision and never gates one
          (CLAUDE.md); a pace figure with no such sentence next to it is read
          as a score, and then someone acts on it. */}
      <div className="card pad" style={{ marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: "var(--fs-ui)" }}>
          {staff
            ? <>This is <b>where to look</b>, not a verdict. A fast assessment can be an expert
                who knows the framework. Read the pace <b>together with</b> the spread of levels
                and whether evidence was written — those are the ones that cannot be produced by
                someone who was not thinking.</>
            : <>Your own timings. They are recorded so that a rushed assessment can be spotted
                before it reaches your results — nothing here is a score, and nobody is graded
                on speed.</>}
        </p>
      </div>

      <Headline summary={summary} />

      {byCe.some((r) => r.measured > 0) && (
        <>
          <div className="sec-head" style={{ marginTop: 26 }}>
            <h2>By competency</h2>
            <span className="rule" />
          </div>
          <div className="card pad">
            <div className="tablewrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Competency</th>
                    <th className="num">Scored</th>
                    <th className="num">Timed</th>
                    <th className="num">Median per control</th>
                  </tr>
                </thead>
                <tbody>
                  {byCe.filter((r) => r.scored > 0).map((r) => (
                    <tr key={r.ce_code}>
                      <td>{r.ce_code} {ceName.get(r.ce_code) ?? ""}</td>
                      <td className="num">{r.scored}</td>
                      <td className="num">{r.measured}</td>
                      <td className="num">{paceLabel(r.medianSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The five numbers, each with the sentence that says how to read it.
 *
 * Every figure carries its own denominator. "12 answered faster than the text
 * can be read" means nothing without "of 40 timed", and the gap between
 * `scored` and `measured` is the honest part: readings are missing for answers
 * saved before this was built, and for any answer whose clock was not
 * believable. The screen says how many it has rather than treating absence as
 * evidence.
 */
function Headline({ summary: s }: { summary: PaceSummary }) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const trend = s.firstHalfSeconds !== null && s.secondHalfSeconds !== null
    ? s.secondHalfSeconds - s.firstHalfSeconds
    : null;

  if (s.scored === 0) {
    return (
      <div className="card pad">
        <p className="note" style={{ margin: 0 }}>No controls scored yet — nothing to analyse.</p>
      </div>
    );
  }

  return (
    <div className="card pad">
      <div className="tablewrap">
        <table className="grid">
          <tbody>
            <tr>
              <td><b>Typical time per control</b></td>
              <td className="num"><b>{paceLabel(s.medianSeconds)}</b></td>
              <td className="note">
                Median of <b className="tnum">{s.measured}</b> timed
                {" "}answer{s.measured === 1 ? "" : "s"}, of{" "}
                <b className="tnum">{s.scored}</b> scored. Time with the tab hidden is not counted.
              </td>
            </tr>
            <tr>
              <td><b>Getting faster?</b></td>
              <td className="num">
                {trend === null
                  ? "—"
                  : `${trend < 0 ? "−" : "+"}${paceLabel(Math.abs(trend))}`}
              </td>
              <td className="note">
                {trend === null
                  ? <>Needs at least 8 timed answers before a first-half / second-half
                      comparison says anything.</>
                  : <>Second half {paceLabel(s.secondHalfSeconds)} against first half{" "}
                      {paceLabel(s.firstHalfSeconds)}. Speeding up is normal — the scale
                      becomes familiar.</>}
              </td>
            </tr>
            <tr>
              <td><b>Faster than reading</b></td>
              <td className="num"><b className="tnum">{s.underReading}</b></td>
              {/* Worded as a lower bound, because that is what it is. The
                  clock cannot start before the page becomes interactive, so a
                  full page load loses the reading time before hydration —
                  which makes an answer look FASTER than it was. Claiming "the
                  words were not seen" would be the measurement overstating
                  itself in the accusing direction. */}
              <td className="note">
                Timed answers recorded as taking less than the control&rsquo;s own text takes
                to read at 200&nbsp;wpm. Timing starts when the page becomes interactive, so
                it under-counts rather than over-counts — treat this as a prompt to look, not
                as proof.
              </td>
            </tr>
            <tr>
              <td><b>Levels used</b></td>
              <td className="num">
                <b className="tnum">{s.levelsUsed}</b> of 6
              </td>
              <td className="note">
                <b className="tnum">{pct(s.modalShare)}</b> of answers sit on a single level.
                A real profile has peaks and troughs; one level repeated is the shape of a
                sheet filled in without reading it — and it cannot be produced by going slowly.
              </td>
            </tr>
            <tr>
              <td><b>Evidence written</b></td>
              <td className="num"><b className="tnum">{pct(s.evidenceShare)}</b></td>
              <td className="note">
                The field is optional and never scored, so a low share is not a fault. It is
                here because it is effort that waiting cannot fake.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Empty state, for "you have none" and for "that id names nothing". */
function NothingToAnalyse({ unknown = false }: { unknown?: boolean }) {
  return (
    <div className="section">
      <div className="card pad">
        <h2 style={{ fontSize: "var(--fs-h3)", fontWeight: 650, margin: "0 0 6px" }}>Nothing to analyse</h2>
        <p className="note" style={{ margin: 0 }}>
          {unknown
            ? <>That assessment could not be found — it may have been archived.{" "}
                <Link href="/analysis">Back to everyone</Link>.</>
            : <>You have no assessment in the {currentCycle()} cycle. Once you have scored a
                few controls, this page will show how the work is going.</>}
        </p>
      </div>
    </div>
  );
}

/** The assessor's way in: everyone in the cycle who has started. */
async function Picker() {
  const rows = await listAssessments();
  const started = rows.filter((r) => r.state !== "draft" || r.started_at);

  return (
    <div className="section">
      <div className="sec-head">
        <h2>Assessment analysis</h2>
        <span className="rule" />
        <span className="eyebrow">cycle {currentCycle()}</span>
      </div>

      <div className="card pad">
        <p className="note" style={{ marginTop: 0 }}>
          How each assessment was filled in — pace, and two things pace alone cannot tell you.
          Pick a person.
        </p>
        {started.length === 0
          ? <p className="note" style={{ margin: 0 }}>Nobody has started scoring yet.</p>
          : (
            <ul className="picklist">
              {started.map((r) => (
                <li key={r.id}>
                  <Link className="card pad ce-row" href={`/analysis?a=${r.id}`}>
                    <div className="ce-main">
                      <b>{r.assessee_name}</b>
                      <span className="note">{r.assessee_role ?? ""}</span>
                    </div>
                    <span className="pill pill-neutral">{r.state.replace("_", " ")}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}
