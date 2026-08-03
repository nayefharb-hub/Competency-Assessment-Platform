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
}

const ASSESSMENT_COLUMNS =
  "id, framework_id, profile_id, assessee_id, assessor_id, cycle, state, submitted_at, approved_at, started_at, completed_at";

async function rowById(id: string): Promise<AssessmentRow> {
  return unwrap(
    "assessment fetch",
    await db().from("assessment").select(ASSESSMENT_COLUMNS).eq("id", id).maybeSingle(),
  ) as AssessmentRow;
}

/** Read an assessment without creating one. Null when the person hasn't started. */
export async function findAssessment(
  assesseeId: string,
  cycle = currentCycle(),
): Promise<AssessmentRow | null> {
  const found = await db()
    .from("assessment")
    .select(ASSESSMENT_COLUMNS)
    .eq("assessee_id", assesseeId)
    .eq("cycle", cycle)
    .maybeSingle();
  if (found.error) throw new Error(`Supabase assessment lookup failed: ${found.error.message}`);
  return (found.data as AssessmentRow) ?? null;
}

/**
 * The assessee's assessment for a cycle, created on first visit to the
 * self-assessment. Deliberately NOT called from read-only screens: a stray row
 * for the Head of PMO would land in the completion numbers.
 */
export async function getOrCreateAssessment(
  assesseeId: string,
  cycle = currentCycle(),
): Promise<AssessmentRow> {
  const existing = await findAssessment(assesseeId, cycle);
  if (existing) return existing;

  const fw = await getFramework();
  const profile = fw.profiles.find((p) => p.name === DEFAULT_PROFILE) ?? fw.profiles[0];
  if (!profile) throw new Error("No benchmark profile found — is the database seeded?");
  const frameworkId = await frameworkIdOf();

  const created = await db()
    .from("assessment")
    .insert({
      framework_id: frameworkId,
      profile_id: profile.id,
      assessee_id: assesseeId,
      cycle,
      state: "draft",
    })
    .select(ASSESSMENT_COLUMNS)
    .maybeSingle();
  if (!created.error) return created.data as AssessmentRow;

  // A concurrent first visit loses the unique(assessee_id, cycle) race — the
  // winner's row is now there to read. Re-read ONCE: retrying blindly would
  // spin forever on any other insert failure.
  const raced = await findAssessment(assesseeId, cycle);
  if (raced) return raced;
  throw new Error(`Could not create an assessment: ${created.error.message}`);
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
 * All assessments in a cycle. Batched on purpose: assembleAssessment costs four
 * queries per person, so listing nine of them one at a time is 36 round trips
 * for a screen that only needs names and states.
 */
export async function listAssessments(cycle = currentCycle()): Promise<Assessment[]> {
  const sb = db();
  const rows = unwrap(
    "assessment list",
    await sb.from("assessment").select(ASSESSMENT_COLUMNS).eq("cycle", cycle).order("created_at"),
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
      assessee_is_pm: person?.role === "assessee",
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
    } satisfies Assessment;
  });
}

/* ----------------------------------------------------------------- write */

async function assertState(id: string, allowed: AssessmentState[]): Promise<AssessmentRow> {
  const row = await rowById(id);
  if (!allowed.includes(row.state)) {
    throw new Error(
      `This assessment is ${row.state.replace("_", " ")} — it cannot be changed here.`,
    );
  }
  return row;
}

/**
 * PM self-score. First save stamps started_at — one half of the time-to-complete
 * metric that the whole prototype is meant to test.
 */
export async function saveSelfScore(
  user: AppUser,
  assessmentId: string,
  controlCode: string,
  level: Level | null,
  evidence: string | null,
): Promise<void> {
  const row = await assertState(assessmentId, ["draft"]);
  if (row.assessee_id !== user.id) throw new Error("That assessment belongs to someone else.");

  const fw = await getFramework();
  const control = fw.controlByCode(controlCode);
  if (!control?.id) throw new Error(`Unknown control ${controlCode}`);
  if (!control.active) throw new Error(`Control ${controlCode} is inactive and is not scored.`);

  const sb = db();
  const write = await sb.from("score").upsert(
    {
      assessment_id: assessmentId,
      control_id: control.id,
      self_level: level,
      evidence,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "assessment_id,control_id" },
  );
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

  const [all, invitedCount] = await Promise.all([
    listAssessments(cycle),
    db().from("app_user").select("id", { count: "exact", head: true }).eq("role", "assessee")
      .then((r) => r.count ?? 0),
  ]);

  // Only project managers are being measured. The Head of PMO opening the
  // self-assessment screen must not move the completion rate.
  const assessments = all.filter((a) => a.assessee_is_pm !== false);

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
    // an invited PM who has not opened the tool still counts against completion
    invited: Math.max(invitedCount, assessments.length),
    started: assessments.filter((a) => a.started_at != null).length,
    finished: assessments.filter((a) => a.completed_at != null).length,
    approved: assessments.filter((a) => a.state === "approved").length,
    median_hours: median(durations),
    rows,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
