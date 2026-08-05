/**
 * Assessment data layer — the only place assessments are read or written.
 *
 * State machine (eng plan §State machine):
 *   draft ──PM submits──▶ self_submitted ──assessor approves──▶ approved (locked)
 *
 * Every mutation asserts the state it requires, so a stale tab or a replayed
 * form post cannot move an approved record. Access control is enforced here
 * rather than in the UI: `loadForAssessee` strips the assessor's scores and the
 * targets until the assessment is approved.
 */
import "server-only";
import { db, unwrap } from "../supabase/server";
import { DEFAULT_PROFILE, getFramework } from "../framework";
import type {
  Assessment, AssessmentState, AppUser, CompletionStats, Level, Score,
} from "../types";
import type { PaceScore } from "../pace";

export function currentCycle(): string {
  return String(new Date().getUTCFullYear());
}

interface AssessmentRow {
  id: string;
  framework_id: string;
  profile_id: string;
  assessee_id: string;
  assessor_id: string | null;
  cycle: string;
  state: AssessmentState;
  submitted_at: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  deleted_reason: string | null;
}

const ASSESSMENT_COLUMNS =
  "id, framework_id, profile_id, assessee_id, assessor_id, cycle, state, submitted_at, approved_at, started_at, completed_at, deleted_at, deleted_by, deleted_reason";

async function rowById(id: string): Promise<AssessmentRow> {
  return unwrap(
    "assessment fetch",
    await db().from("assessment").select(ASSESSMENT_COLUMNS).eq("id", id).maybeSingle(),
  ) as AssessmentRow;
}

/**
 * The person's LIVE assessment for the cycle, or null.
 *
 * Archived rows are excluded here rather than filtered by each caller: an
 * archived assessment is one that no longer counts, and a read path that
 * forgets to say so is exactly how an archived record leaks back into a rollup.
 * A person may accumulate several archived rows per cycle (0004 allows it), so
 * this must filter before maybeSingle() or it would start throwing on the
 * second archive.
 */
export async function findAssessment(
  assesseeId: string,
  cycle = currentCycle(),
): Promise<AssessmentRow | null> {
  const found = await db()
    .from("assessment")
    .select(ASSESSMENT_COLUMNS)
    .eq("assessee_id", assesseeId)
    .eq("cycle", cycle)
    .is("deleted_at", null)
    .maybeSingle();
  if (found.error) throw new Error(`Supabase assessment lookup failed: ${found.error.message}`);
  return (found.data as AssessmentRow) ?? null;
}

/**
 * The most recently archived assessment for the cycle. Used only to tell an
 * assessee the truth — "yours was withdrawn" reads very differently from "you
 * were never assigned one", and after an archive the second is what they would
 * otherwise be shown.
 */
export async function findArchivedAssessment(
  assesseeId: string,
  cycle = currentCycle(),
): Promise<AssessmentRow | null> {
  const found = await db()
    .from("assessment")
    .select(ASSESSMENT_COLUMNS)
    .eq("assessee_id", assesseeId)
    .eq("cycle", cycle)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })
    .limit(1);
  if (found.error) throw new Error(`Supabase archive lookup failed: ${found.error.message}`);
  return ((found.data ?? [])[0] as AssessmentRow) ?? null;
}

/**
 * Assign a cycle to people. This is the ONLY way an assessment comes into
 * existence — visiting /assess no longer creates one.
 *
 * That matters for more than tidiness. The completion figure is the number the
 * pilot exists to produce, and its denominator has to be "how many people were
 * asked", which nothing recorded while assessments appeared because somebody
 * browsed to a page. It had to be inferred from who happened to hold a login.
 * Now it is a fact: count the assignments.
 *
 * Idempotent against `unique (assessee_id, cycle)` — assigning the same person
 * twice is a no-op, so the admin can add one late arrival without unpicking
 * who already has one.
 */
export async function assignAssessment(
  admin: AppUser,
  assesseeIds: string[],
  cycle = currentCycle(),
): Promise<{ assigned: number; alreadyHad: number }> {
  if (assesseeIds.length === 0) return { assigned: 0, alreadyHad: 0 };

  const sb = db();
  const fw = await getFramework();
  const profile = fw.profiles.find((p) => p.name === DEFAULT_PROFILE) ?? fw.profiles[0];
  if (!profile) throw new Error("No benchmark profile found — is the database seeded?");
  const frameworkId = await frameworkIdOf();

  // Live rows only. Somebody whose cycle was archived can be assigned again —
  // that is what the partial unique index in 0004 is for.
  const existing = unwrap(
    "assignment lookup",
    await sb.from("assessment").select("assessee_id")
      .eq("cycle", cycle).is("deleted_at", null).in("assessee_id", assesseeIds),
  ) as { assessee_id: string }[];
  const already = new Set(existing.map((e) => e.assessee_id));
  const fresh = assesseeIds.filter((id) => !already.has(id));
  if (fresh.length === 0) return { assigned: 0, alreadyHad: already.size };

  const now = new Date().toISOString();
  const created = await sb.from("assessment").insert(
    fresh.map((assessee_id) => ({
      framework_id: frameworkId,
      profile_id: profile.id,
      assessee_id,
      cycle,
      state: "draft" as const,
      assigned_at: now,
      assigned_by: admin.id,
    })),
  );
  if (created.error) throw new Error(`Assigning failed: ${created.error.message}`);

  return { assigned: fresh.length, alreadyHad: already.size };
}

/** Withdraw an assignment that has not been started. Deliberately narrow: once
 *  somebody has scored anything, taking it away is an archive decision (N6),
 *  not an undo. */
export async function unassignAssessment(
  assessmentId: string,
): Promise<void> {
  const sb = db();
  const { count } = await sb
    .from("score")
    .select("*", { count: "exact", head: true })
    .eq("assessment_id", assessmentId)
    .not("self_level", "is", null);
  if ((count ?? 0) > 0) {
    throw new Error(
      `That assessment already has ${count} score${count === 1 ? "" : "s"} — withdrawing it would destroy them.`,
    );
  }
  const gone = await sb
    .from("assessment").delete()
    .eq("id", assessmentId).eq("state", "draft").select("id");
  if (gone.error) throw new Error(`Withdrawing failed: ${gone.error.message}`);
  if ((gone.data ?? []).length === 0) {
    throw new Error("That assessment is no longer a draft — reload to see its current state.");
  }
}

/* --------------------------------------------------------------- archive */

/**
 * Archive (N6) — the answer to "can an admin delete an assessment?".
 *
 * A hard delete takes `started_at` and `completed_at` with it, and those two
 * columns ARE the completion metric. The worked example in docs/pilot-feedback.md
 * showed one real-world event ("Ethan left, remove his record") reporting either
 * 80% or 100% completion depending on which route was used, with nothing on
 * record to reconcile it afterwards. That is disqualifying when the figure is
 * the deliverable.
 *
 * Archiving keeps the timestamps and the reason, so the number stays
 * reconstructible while the record leaves day-to-day use. A genuine hard delete
 * — a data-protection request — remains a deliberate script run.
 *
 * The reason is required, not decorative: an archive with no reason is
 * indistinguishable from a mistake six months later.
 */
export async function archiveAssessment(
  admin: AppUser,
  assessmentId: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error("Say why this is being archived — the reason is the audit trail.");
  }

  const gone = await db()
    .from("assessment")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: admin.id,
      deleted_reason: trimmed,
    })
    .eq("id", assessmentId)
    // guard in the WHERE clause: archiving an archived row would overwrite the
    // original reason and the original timestamp with a second, later one
    .is("deleted_at", null)
    .select("id");
  if (gone.error) throw new Error(`Archiving failed: ${gone.error.message}`);
  if ((gone.data ?? []).length === 0) {
    throw new Error("That assessment is already archived — reload to see its current state.");
  }
}

/**
 * Undo an archive. Archiving is meant to be the safe option, and an option you
 * cannot reverse is not the safe one — a mis-archived record would otherwise be
 * recoverable only through a database restore.
 *
 * Refuses when the person already holds a live assessment for that cycle:
 * restoring would produce two, which the partial unique index forbids anyway.
 * Better a sentence than a constraint-violation stack trace.
 */
export async function restoreAssessment(assessmentId: string): Promise<void> {
  const row = await rowById(assessmentId);
  if (!row.deleted_at) throw new Error("That assessment is not archived.");

  const live = await findAssessment(row.assessee_id, row.cycle);
  if (live) {
    throw new Error(
      "That person already has a live assessment for this cycle — archive it first if you want this one back.",
    );
  }

  const back = await db()
    .from("assessment")
    .update({ deleted_at: null, deleted_by: null, deleted_reason: null })
    .eq("id", assessmentId)
    .not("deleted_at", "is", null)
    .select("id");
  if (back.error) throw new Error(`Restoring failed: ${back.error.message}`);
  if ((back.data ?? []).length === 0) {
    throw new Error("That assessment is no longer archived — reload to see its current state.");
  }
}

/** Archived assessments for a cycle, newest first — the history view. */
export async function listArchived(cycle = currentCycle()): Promise<Assessment[]> {
  return listAssessments(cycle, { archived: true });
}

async function frameworkIdOf(): Promise<string> {
  const row = unwrap(
    "framework id",
    await db().from("framework").select("id").eq("name", "IPMA ICB4").eq("version", "v4.0.1").maybeSingle(),
  ) as { id: string };
  return row.id;
}

/* ------------------------------------------------------------------ read */

interface ScoreRow {
  control_id: string;
  self_level: number | null;
  assessor_level: number | null;
  assessor_touched: boolean;
  evidence: string | null;
}

async function assembleAssessment(
  row: AssessmentRow,
  opts: { redact: boolean },
): Promise<Assessment> {
  const sb = db();
  const fw = await getFramework();
  const codeById = new Map(fw.controls.map((c) => [c.id as string, c.code]));

  const [scoreRows, person, profile, snapshotRows] = await Promise.all([
    sb.from("score")
      .select("control_id, self_level, assessor_level, assessor_touched, evidence")
      .eq("assessment_id", row.id).limit(5000)
      .then((r) => unwrap("score fetch", r) as ScoreRow[]),
    sb.from("app_user").select("full_name, job_title").eq("id", row.assessee_id).maybeSingle()
      .then((r) => (r.data ?? { full_name: "Unknown", job_title: null }) as { full_name: string; job_title: string | null }),
    sb.from("benchmark_profile").select("name").eq("id", row.profile_id).maybeSingle()
      .then((r) => (r.data ?? { name: DEFAULT_PROFILE }) as { name: string }),
    sb.from("target_snapshot").select("control_id, target_level").eq("assessment_id", row.id).limit(5000)
      .then((r) => (r.data ?? []) as { control_id: string; target_level: number | null }[]),
  ]);

  const approved = row.state === "approved";
  const scores: Score[] = scoreRows.map((s) => ({
    control_code: codeById.get(s.control_id) ?? s.control_id,
    self_level: s.self_level as Level | null,
    // Before approval the assessor's revision is not the assessee's to see.
    assessor_level: opts.redact && !approved ? null : (s.assessor_level as Level | null),
    assessor_touched: opts.redact && !approved ? false : s.assessor_touched,
    evidence: s.evidence,
  }));

  const snapshot: Record<string, Level | null> = {};
  for (const s of snapshotRows) {
    const code = codeById.get(s.control_id);
    if (code) snapshot[code] = s.target_level as Level | null;
  }

  return {
    id: row.id,
    assessee_id: row.assessee_id,
    assessee_name: person.full_name,
    assessee_role: person.job_title ?? "Project Manager",
    cycle: row.cycle,
    profile: profile.name,
    profile_id: row.profile_id,
    state: row.state,
    scores,
    started_at: row.started_at,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    completed_at: row.completed_at,
    snapshot_targets: snapshot,
    // Carried on the single-record path too, not just the list path — the
    // review screen is the one place an archived record is still opened, so
    // this is exactly where it must be able to say so.
    deleted_at: row.deleted_at,
    deleted_reason: row.deleted_reason,
  };
}

/** Full view — assessor and admin only. */
export async function loadAssessment(id: string): Promise<Assessment> {
  return assembleAssessment(await rowById(id), { redact: false });
}

/** Assessee's own view: assessor scores hidden until the record is approved. */
export async function loadForAssessee(user: AppUser, id: string): Promise<Assessment> {
  const row = await rowById(id);
  if (row.assessee_id !== user.id) {
    throw new Error("That assessment belongs to someone else.");
  }
  return assembleAssessment(row, { redact: true });
}

/**
 * Just the scores, for the one-control-at-a-time screen.
 *
 * That page needs the assessee's own levels and the assessment's state, and
 * nothing else — but it reached them through findAssessment() +
 * loadForAssessee(), which re-fetched the row it had just been handed and then
 * joined the person, the benchmark profile and the target snapshot, none of
 * which it renders. Six round trips for one query's worth of data, on the
 * screen a PM loads 132 times.
 *
 * Kept for the callers that already hold a row. The screens use
 * findAssessmentWithScores() below, which gets the same data in one request.
 */
export async function scoresFor(user: AppUser, row: AssessmentRow): Promise<Score[]> {
  if (row.assessee_id !== user.id) {
    throw new Error("That assessment belongs to someone else.");
  }
  const rows = unwrap(
    "score fetch",
    await db().from("score")
      .select("control_id, self_level, assessor_level, assessor_touched, evidence")
      .eq("assessment_id", row.id).limit(5000),
  ) as ScoreRow[];
  return redactScores(rows, row);
}

/**
 * The row AND its scores, in one request — the assessee's whole read path.
 *
 * Two queries became one for the same reason the framework's nine did: Supabase
 * charges a fixed ~31ms per REST call regardless of what it returns, so on the
 * screen a PM loads 132 times, the second call cost more than the data in it.
 * `score.assessment_id` already points at `assessment.id`, so PostgREST embeds
 * them without a migration.
 *
 * Deliberately NOT memoised with React's cache(). A save posts to a server
 * action and Next re-renders inside the SAME request, so a cached read would
 * hand the re-render the scores from before the save — "Save and next" showing
 * the previous answer. The row lookup alone would be safe to cache; the scores
 * are exactly what changes.
 */
export async function findAssessmentWithScores(
  user: AppUser,
  cycle = currentCycle(),
): Promise<{ row: AssessmentRow; scores: Score[] } | null> {
  const found = await db()
    .from("assessment")
    .select(`${ASSESSMENT_COLUMNS}, score(control_id, self_level, assessor_level, assessor_touched, evidence)`)
    .eq("assessee_id", user.id)
    .eq("cycle", cycle)
    .is("deleted_at", null)
    .maybeSingle();
  if (found.error) throw new Error(`Supabase assessment lookup failed: ${found.error.message}`);
  if (!found.data) return null;

  const { score, ...row } = found.data as AssessmentRow & { score: ScoreRow[] | null };
  return { row, scores: await redactScores(score ?? [], row) };
}

/**
 * The assessee's redaction rule, in one place: before approval, the assessor's
 * revision is not theirs to see. Shared by both readers above so the two cannot
 * drift — a screen that got the unredacted version would be showing a PM the
 * marking of their own paper.
 */
async function redactScores(rows: ScoreRow[], row: AssessmentRow): Promise<Score[]> {
  const fw = await getFramework();
  const codeById = new Map(fw.controls.map((c) => [c.id as string, c.code]));
  const approved = row.state === "approved";
  return rows.map((s) => ({
    control_code: codeById.get(s.control_id) ?? s.control_id,
    self_level: s.self_level as Level | null,
    assessor_level: approved ? (s.assessor_level as Level | null) : null,
    assessor_touched: approved ? s.assessor_touched : false,
    evidence: s.evidence,
  }));
}

/**
 * The timing rows behind the analysis screen (D28).
 *
 * Its own reader rather than a wider `select` on the paths above, and that is
 * deliberate: `dwell_ms` is wanted by exactly one screen that nobody loads 132
 * times, while `findAssessmentWithScores` is the assessment hot path two PRs
 * were spent making fast. Adding a column there would cost every control load
 * to serve a page reached from a menu.
 *
 * NOT redacted through `redactScores`, because none of the redaction applies:
 * the assessor's revision is not selected here at all, and pace is the PM's own
 * behaviour — the one thing they are entitled to see about themselves before
 * approval (D21). Authorisation is the CALLER's job and every caller is
 * checked; see app/analysis/page.tsx.
 */
export async function paceFor(assessmentId: string): Promise<PaceScore[]> {
  const fw = await getFramework();
  const codeById = new Map(fw.controls.map((c) => [c.id as string, c.code]));
  // Tolerates 0005 not having been applied yet, for the same reason the write
  // does: the screen should say "nothing measured" rather than return a 500.
  // Typed as the narrow shape both branches share; the pace columns are read
  // back optionally below, which is exactly how the fallback leaves them.
  type PaceRow = {
    control_id: string; self_level: number | null; evidence: string | null;
    dwell_ms?: number | null; answered_at?: string | null;
  };
  let read: { data: PaceRow[] | null; error: { code?: string; message: string } | null } =
    await db().from("score")
      .select("control_id, self_level, evidence, dwell_ms, answered_at")
      .eq("assessment_id", assessmentId).limit(5000);
  // Degrade to "no TIMINGS", not to "no data". The first version returned []
  // here, which made the whole screen say "nothing scored yet" about an
  // assessment with 132 answers in it — and threw away the two signals that
  // need no timing at all (levels used, evidence written), which are the ones
  // that matter most and the ones a forged clock cannot touch.
  if (read.error && isMissingPaceColumn(read.error)) {
    warnPaceColumnsMissing();
    read = await db().from("score")
      .select("control_id, self_level, evidence")
      .eq("assessment_id", assessmentId).limit(5000);
  }
  const rows = unwrap("pace fetch", read) as PaceRow[];
  return rows.map((r) => ({
    control_code: codeById.get(r.control_id) ?? r.control_id,
    self_level: r.self_level as Level | null,
    evidence: r.evidence,
    dwell_ms: r.dwell_ms ?? null,
    answered_at: r.answered_at ?? null,
  }));
}

/**
 * All assessments in a cycle. Batched on purpose: assembleAssessment costs four
 * queries per person, so listing nine of them one at a time is 36 round trips
 * for a screen that only needs names and states.
 */
export async function listAssessments(
  cycle = currentCycle(),
  opts: { archived?: boolean } = {},
): Promise<Assessment[]> {
  const sb = db();
  const query = sb.from("assessment").select(ASSESSMENT_COLUMNS).eq("cycle", cycle);
  // Live by default. Every screen and every rollup reads through here, so this
  // one line is what keeps an archived record out of all of them.
  const rows = unwrap(
    "assessment list",
    await (opts.archived
      ? query.not("deleted_at", "is", null).order("deleted_at", { ascending: false })
      : query.is("deleted_at", null).order("created_at")),
  ) as AssessmentRow[];
  if (rows.length === 0) return [];

  const fw = await getFramework();
  const codeById = new Map(fw.controls.map((c) => [c.id as string, c.code]));

  const [people, profiles, scoreRows] = await Promise.all([
    sb.from("app_user").select("id, full_name, job_title, role")
      .in("id", [...new Set(rows.map((r) => r.assessee_id))])
      .then((r) => (r.data ?? []) as { id: string; full_name: string; job_title: string | null; role: string }[]),
    sb.from("benchmark_profile").select("id, name")
      .in("id", [...new Set(rows.map((r) => r.profile_id))])
      .then((r) => (r.data ?? []) as { id: string; name: string }[]),
    sb.from("score")
      .select("assessment_id, control_id, self_level, assessor_level, assessor_touched, evidence")
      .in("assessment_id", rows.map((r) => r.id)).limit(20000)
      .then((r) => (r.data ?? []) as (ScoreRow & { assessment_id: string })[]),
  ]);

  const personById = new Map(people.map((p) => [p.id, p]));
  const profileById = new Map(profiles.map((p) => [p.id, p.name]));
  const scoresByAssessment = new Map<string, (ScoreRow & { assessment_id: string })[]>();
  for (const s of scoreRows) {
    const list = scoresByAssessment.get(s.assessment_id);
    if (list) list.push(s);
    else scoresByAssessment.set(s.assessment_id, [s]);
  }

  return rows.map((row) => {
    const person = personById.get(row.assessee_id);
    return {
      id: row.id,
      assessee_id: row.assessee_id,
      assessee_name: person?.full_name ?? "Unknown",
      assessee_role: person?.job_title ?? "Project Manager",
      cycle: row.cycle,
      profile: profileById.get(row.profile_id) ?? DEFAULT_PROFILE,
      profile_id: row.profile_id,
      state: row.state,
      scores: (scoresByAssessment.get(row.id) ?? []).map((s) => ({
        control_code: codeById.get(s.control_id) ?? s.control_id,
        self_level: s.self_level as Level | null,
        assessor_level: s.assessor_level as Level | null,
        assessor_touched: s.assessor_touched,
        evidence: s.evidence,
      })),
      started_at: row.started_at,
      submitted_at: row.submitted_at,
      approved_at: row.approved_at,
      completed_at: row.completed_at,
      deleted_at: row.deleted_at,
      deleted_reason: row.deleted_reason,
    } satisfies Assessment;
  });
}

/* ----------------------------------------------------------------- write */

async function assertState(id: string, allowed: AssessmentState[]): Promise<AssessmentRow> {
  return assertRowState(await rowById(id), allowed);
}

/**
 * The same guard against a row the caller already has.
 *
 * Split out so the write path can stop re-fetching what it was just handed:
 * saveSelfScoreAction looked the assessment up to find its id, then
 * saveSelfScore looked the same row up again to check its state. Two of the
 * ~31ms floors on the action a PM triggers 132 times.
 *
 * Re-reading was never the safety property here — the row could change between
 * the two reads either way. What actually guards the transition is the WHERE
 * clause on each update (`.eq("state", ...)`), which the database evaluates
 * atomically. This check is for the error message.
 */
function assertRowState(row: AssessmentRow, allowed: AssessmentState[]): AssessmentRow {
  // Checked before the state, and in the one place every mutation passes
  // through: an archived assessment is out of the cycle, so scoring, submitting
  // or approving it would put data into a record the metrics deliberately
  // ignore.
  if (row.deleted_at) {
    throw new Error("This assessment has been archived — it can no longer be changed.");
  }
  if (!allowed.includes(row.state)) {
    throw new Error(
      `This assessment is ${row.state.replace("_", " ")} — it cannot be changed here.`,
    );
  }
  return row;
}

/** Names a pace column (0005), rather than any other column in the payload. */
function isPaceColumn(error: { message?: string }): boolean {
  const m = error.message ?? "";
  return m.includes("dwell_ms") || m.includes("answered_at");
}

/**
 * Is this the specific error that means "migration 0005 has not run yet"?
 *
 * Deliberately narrow. A blanket `catch and retry without the columns` would
 * also swallow a constraint violation, a permissions problem or a genuine
 * write failure, and turn each into a silent half-save. Two codes, because
 * PostgREST reports the same fact differently depending on whether its schema
 * cache is stale (PGRST204) or the statement reached Postgres (42703) — and
 * they are NOT interchangeable, which is why the caller retries in full on the
 * first before dropping anything.
 */
function isMissingPaceColumn(error: { code?: string; message?: string }): boolean {
  return (error.code === "PGRST204" || error.code === "42703") && isPaceColumn(error);
}

/**
 * Said once per instance: a line on every save would bury the deploy log.
 *
 * Module scope, and NOT an exception to the Fluid Compute rule in CLAUDE.md —
 * that rule is about PER-USER state, which leaks between the interleaved
 * requests one instance serves. This is a fact about the DATABASE, identical
 * for every request the instance will ever handle, and the only thing it
 * affects is whether a line is printed twice.
 */
let warnedPace = false;
function warnPaceColumnsMissing() {
  if (warnedPace) return;
  warnedPace = true;
  console.warn(
    "[score] score.dwell_ms / answered_at are missing — saving answers without "
    + "pace. Apply supabase/migrations/0005_pace.sql.",
  );
}

/**
 * PM self-score. First save stamps started_at — one half of the time-to-complete
 * metric that the whole prototype is meant to test.
 */
export async function saveSelfScore(
  user: AppUser,
  /** The row, not an id: the caller has already fetched it to know which one. */
  row: AssessmentRow,
  controlCode: string,
  level: Level | null,
  evidence: string | null,
  /**
   * Time to the FIRST answer for this control, in ms, already sanitised by the
   * caller (D28). NULL means "not measured, or this is a revision" — and in
   * that case the column is left OUT of the upsert, so an existing reading
   * survives. See the client's note in `score-panel.tsx`: a revision must not
   * overwrite the original timing with the seconds it took to change one's
   * mind, or the control gets reported as answered faster than it can be read.
   */
  dwellMs: number | null = null,
): Promise<void> {
  const assessmentId = row.id;
  assertRowState(row, ["draft"]);
  if (row.assessee_id !== user.id) throw new Error("That assessment belongs to someone else.");

  const fw = await getFramework();
  const control = fw.controlByCode(controlCode);
  if (!control?.id) throw new Error(`Unknown control ${controlCode}`);
  if (!control.active) throw new Error(`Control ${controlCode} is inactive and is not scored.`);

  // THE CLIENT'S CLAIM, BOUNDED BY THE SERVER'S CLOCK.
  //
  // `dwellMs` arrives from a browser, and a server action is an ordinary HTTP
  // endpoint: anyone signed in can POST `dwellMs: 180000` on all 132 controls
  // and manufacture a flawless three-minute median in about a second. That
  // matters more than a normal "don't trust the client", because the design
  // argument for why pace is worth recording (D28a) was that padding costs the
  // padder the whole two hours they were trying to avoid — and against a
  // scripted client that cost is zero. A review pass caught the argument, not
  // just the code.
  //
  // The assessment's own `started_at` restores it, and it is already in hand,
  // so this costs no round trip: no control can have been on screen longer
  // than the assessment has existed. It does not detect a *plausible* lie —
  // nothing can — but it puts the forger back where the design assumed they
  // were, having to keep the thing open for as long as they want to claim.
  if (dwellMs !== null && row.started_at) {
    const sinceStart = Date.now() - Date.parse(row.started_at);
    if (Number.isFinite(sinceStart) && dwellMs > Math.max(0, sinceStart)) dwellMs = null;
  }

  const sb = db();
  const now = new Date().toISOString();
  const answer = {
    assessment_id: assessmentId,
    control_id: control.id,
    self_level: level,
    evidence,
    updated_at: now,
  };

  // `answered_at` exists because `updated_at` CANNOT order these readings, and
  // a review pass caught the code asserting the opposite. A trigger
  // (`score_touch`, migration 0001) rewrites `updated_at` on every UPDATE —
  // and `submitSelfAssessment` upserts every score row to prefill
  // `assessor_level`, so pressing Submit stamps all 132 rows with one
  // timestamp. The "getting faster?" trend then splits an arbitrary heap order
  // in half and can report a PM who sped up as having slowed down, in exactly
  // the state an assessor looks at. `setAssessorLevels` is worse still: it
  // re-stamps only the controls the assessor already doubted.
  //
  // Only this function writes it; every assessor-side path omits it, and a
  // column absent from an upsert payload is left alone. `lib/db/people.ts`
  // documents the same trigger for `last_scored` — the knowledge existed, it
  // just had not reached here.
  // The two are written TOGETHER or not at all, and that pairing is the point:
  // `answered_at` timestamps the same event `dwell_ms` measures — the first
  // answer — so ordering by it is ordering the readings themselves. Writing it
  // on a revision instead would move a reading to a position in the sequence
  // that the reading did not come from.
  const pace = dwellMs === null ? {} : { dwell_ms: dwellMs, answered_at: now };

  let write = await sb.from("score").upsert(
    { ...answer, ...pace },
    { onConflict: "assessment_id,control_id" },
  );

  // MIGRATION ORDERING, made harmless (D28). Migrations here are applied by
  // hand in the Supabase SQL editor, while code deploys itself on push — so
  // there is always a window where the running build is ahead of the schema.
  // Without this branch that window is a TOTAL SCORING OUTAGE: every save
  // fails on an unknown column, and the outbox faithfully retries the failure
  // every 30 seconds for as long as it lasts.
  //
  // The answer is what matters; the timing is instrumentation. So when the
  // column is not there yet, drop the instrumentation and save the answer.
  // Self-healing: nothing is cached, so the first save after 0005 is applied
  // starts recording again with no restart and no intervention.
  // PGRST204 is the STALE-CACHE case: the column exists, PostgREST has not
  // noticed yet. Retrying the full payload once is usually enough, and it must
  // be tried first — dropping the column here would leave the PREVIOUS answer's
  // dwell attached to this new one, which is worse than no reading at all in a
  // dataset used to argue that somebody rushed.
  if (write.error?.code === "PGRST204" && isPaceColumn(write.error)) {
    write = await sb.from("score").upsert(
      { ...answer, ...pace }, { onConflict: "assessment_id,control_id" },
    );
  }
  // 42703 is the real thing: no such column. Nothing stale can exist, so
  // dropping it is safe.
  if (write.error && isMissingPaceColumn(write.error)) {
    warnPaceColumnsMissing();
    write = await sb.from("score").upsert(answer, { onConflict: "assessment_id,control_id" });
  }
  if (write.error) throw new Error(`Saving the score failed: ${write.error.message}`);

  if (!row.started_at) {
    await sb.from("assessment").update({ started_at: new Date().toISOString() }).eq("id", assessmentId);
  }
}

/**
 * draft → self_submitted. Copies each self_level into assessor_level so the
 * assessor reviews a pre-filled sheet rather than re-scoring from scratch, and
 * stamps completed_at (the "finished" flag + the end of the timing window).
 */
export async function submitSelfAssessment(
  user: AppUser,
  assessmentId: string,
): Promise<void> {
  const row = await assertState(assessmentId, ["draft"]);
  if (row.assessee_id !== user.id) throw new Error("That assessment belongs to someone else.");

  const sb = db();
  const fw = await getFramework();
  const scores = unwrap(
    "submit fetch",
    await sb.from("score")
      .select("control_id, self_level, evidence, assessor_touched")
      .eq("assessment_id", assessmentId).limit(5000),
  ) as ScoreRow[];

  // The UI disables the button until every active control is scored; enforce it
  // here too, so a stale tab or a crafted post cannot submit a half assessment.
  const scored = new Set(scores.filter((s) => s.self_level !== null).map((s) => s.control_id));
  const missing = fw.activeControls.filter((c) => !scored.has(c.id as string)).length;
  if (missing > 0) {
    throw new Error(`${missing} control${missing === 1 ? "" : "s"} still need a score before you can submit.`);
  }

  if (scores.length > 0) {
    const prefill = await sb.from("score").upsert(
      scores.map((s) => ({
        assessment_id: assessmentId,
        control_id: s.control_id,
        self_level: s.self_level,
        assessor_level: s.self_level,
        assessor_touched: s.assessor_touched,
        evidence: s.evidence,
      })),
      { onConflict: "assessment_id,control_id" },
    );
    if (prefill.error) {
      throw new Error(`Pre-filling the assessor sheet failed: ${prefill.error.message}`);
    }
  }

  const now = new Date().toISOString();
  const move = await sb
    .from("assessment")
    .update({
      state: "self_submitted",
      submitted_at: now,
      completed_at: now,
      started_at: row.started_at ?? now,
    })
    .eq("id", assessmentId)
    // guard the transition in the WHERE clause, not just the read above
    .eq("state", "draft")
    .select("id");
  if (move.error) throw new Error(`Submitting failed: ${move.error.message}`);
  // An update that matched nothing is NOT an error in PostgREST. Without this
  // the screen would report a submission that never happened.
  if ((move.data ?? []).length === 0) {
    throw new Error("This assessment was already submitted — reload to see its current state.");
  }
}

/**
 * Assessor overrides. The assessor's score is authoritative — it is what the
 * results show — and `assessor_touched` records that this control was genuinely
 * looked at, which is what makes review coverage meaningful.
 */
export async function setAssessorLevels(
  assessmentId: string,
  changes: { control_code: string; level: Level }[],
): Promise<number> {
  if (changes.length === 0) return 0;
  await assertState(assessmentId, ["self_submitted"]);
  const fw = await getFramework();

  const rows = changes.map(({ control_code, level }) => {
    const control = fw.controlByCode(control_code);
    if (!control?.id) throw new Error(`Unknown control ${control_code}`);
    return {
      assessment_id: assessmentId,
      control_id: control.id as string,
      assessor_level: level,
      assessor_touched: true,
      updated_at: new Date().toISOString(),
    };
  });

  const write = await db().from("score").upsert(rows, { onConflict: "assessment_id,control_id" });
  if (write.error) throw new Error(`Saving the revisions failed: ${write.error.message}`);
  return rows.length;
}

/**
 * "Accept all remaining" — fills gaps with the self-score WITHOUT setting
 * assessor_touched, so review coverage stays honest about what was actually
 * looked at.
 */
export async function acceptAllRemaining(assessmentId: string): Promise<number> {
  await assertState(assessmentId, ["self_submitted"]);
  const sb = db();
  const rows = unwrap(
    "accept-all fetch",
    await sb.from("score").select("control_id, self_level, assessor_level, assessor_touched, evidence")
      .eq("assessment_id", assessmentId).limit(5000),
  ) as ScoreRow[];

  const pending = rows.filter((r) => r.assessor_level === null && r.self_level !== null);
  if (pending.length > 0) {
    const write = await sb.from("score").upsert(
      pending.map((r) => ({
        assessment_id: assessmentId,
        control_id: r.control_id,
        self_level: r.self_level,
        assessor_level: r.self_level,
        assessor_touched: r.assessor_touched,
        evidence: r.evidence,
      })),
      { onConflict: "assessment_id,control_id" },
    );
    if (write.error) throw new Error(`Accepting scores failed: ${write.error.message}`);
  }
  return pending.length;
}

/**
 * Approve and lock. Freezes the per-control targets applied by this
 * assessment's benchmark profile into target_snapshot (rollup-spec §6) so a
 * later profile change cannot retrospectively shift a historic gap.
 */
export async function approveAssessment(
  assessor: AppUser,
  assessmentId: string,
): Promise<void> {
  const row = await assertState(assessmentId, ["self_submitted"]);
  const sb = db();
  const fw = await getFramework();

  const profile = await sb
    .from("benchmark_profile")
    .select("name")
    .eq("id", row.profile_id)
    .maybeSingle();
  const profileName = (profile.data as { name: string } | null)?.name ?? DEFAULT_PROFILE;
  const targets = fw.targetsForProfile(profileName);

  // Same rule as submit: the button is disabled until every active control has
  // an authoritative score, and the data layer says so too.
  const scores = unwrap(
    "approve fetch",
    await sb.from("score").select("control_id, assessor_level").eq("assessment_id", assessmentId).limit(5000),
  ) as { control_id: string; assessor_level: number | null }[];
  const decided = new Set(
    scores.filter((s) => s.assessor_level !== null).map((s) => s.control_id),
  );
  const undecided = fw.activeControls.filter((c) => !decided.has(c.id as string)).length;
  if (undecided > 0) {
    throw new Error(
      `${undecided} active control${undecided === 1 ? "" : "s"} still have no assessor score — accept or override them before approving.`,
    );
  }

  const snapshot = fw.controls
    .filter((c) => c.id)
    .map((c) => ({
      assessment_id: assessmentId,
      control_id: c.id as string,
      target_level: targets.get(c.code) ?? c.target_level,
    }));

  const frozen = await sb
    .from("target_snapshot")
    .upsert(snapshot, { onConflict: "assessment_id,control_id" });
  if (frozen.error) throw new Error(`Snapshotting targets failed: ${frozen.error.message}`);

  const move = await sb
    .from("assessment")
    .update({
      state: "approved",
      approved_at: new Date().toISOString(),
      assessor_id: assessor.id,
    })
    .eq("id", assessmentId)
    .eq("state", "self_submitted")
    .select("id");
  if (move.error) throw new Error(`Approving failed: ${move.error.message}`);
  if ((move.data ?? []).length === 0) {
    throw new Error("This assessment was already approved — reload to see its current state.");
  }
}

/* -------------------------------------------------- completion (T9, P1) */

/**
 * Completion instrumentation. The prototype's central question is whether PMs
 * actually FINISH online when they would not finish a spreadsheet, so this is
 * a first-class metric, not an afterthought: who finished, and how long the
 * median finisher took from first score to submit.
 */
export async function completionStats(cycle = currentCycle()): Promise<CompletionStats> {
  const fw = await getFramework();
  const activeCodes = new Set(fw.activeControls.map((c) => c.code));

  // The denominator is the number of people ASKED — one row per assignment,
  // nothing inferred. Before assignment existed this had to be guessed with
  // `Math.max(count of assessee logins, count of assessments)`, and filtered
  // with `assessee_is_pm` to keep stray auto-created rows out. Both of those
  // compensated for assessments appearing unbidden; neither is needed now, and
  // both are deleted rather than left as belt-and-braces that would quietly
  // disagree with this one.
  const [assessments, archived] = await Promise.all([
    listAssessments(cycle),
    listAssessments(cycle, { archived: true }),
  ]);

  const durations: number[] = [];
  const rows: CompletionStats["rows"] = assessments.map((a) => {
    const scored = a.scores.filter(
      (s) => s.self_level !== null && activeCodes.has(s.control_code),
    ).length;
    const finished = a.completed_at != null;
    const hours =
      a.started_at && a.completed_at
        ? (Date.parse(a.completed_at) - Date.parse(a.started_at)) / 3_600_000
        : null;
    if (finished && hours !== null) durations.push(hours);
    return {
      assessment_id: a.id,
      assessee_name: a.assessee_name,
      state: a.state,
      scored,
      active_controls: fw.activeControls.length,
      finished,
      hours,
    };
  });

  return {
    cycle,
    // assigned, not invited: someone with a login who was never asked to do
    // this cycle is not a missing completion
    assigned: assessments.length,
    started: assessments.filter((a) => a.started_at != null).length,
    finished: assessments.filter((a) => a.completed_at != null).length,
    approved: assessments.filter((a) => a.state === "approved").length,
    median_hours: median(durations),
    // Reported, not merely excluded. An archive changes both halves of the
    // completion fraction, and a number that moved for a reason nobody can see
    // is the failure mode this whole feature exists to avoid (N6) — so the
    // screen states its own rule: "4 of 5 · 1 archived, excluded".
    archived: archived.length,
    archived_finished: archived.filter((a) => a.completed_at != null).length,
    rows,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
