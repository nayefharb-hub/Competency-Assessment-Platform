/**
 * People administration — the allowlist, from inside the app.
 *
 * Every account is two rows written together: one in `auth.users` (so the
 * person can sign in) and one in `public.app_user` (so they are allowed to).
 * `app_user` IS the allowlist — a valid Supabase session with no row here gets
 * nothing — which is why both halves must succeed or neither should exist.
 *
 * DUPLICATION, ON PURPOSE: `scripts/invite.mjs` writes the same two halves.
 * They cannot share code — the script is plain Node ESM, this is TypeScript
 * behind `server-only` with `@/` path aliases Node will not resolve. Keep the
 * two in step by hand; `scripts/e2e.mjs` asserts both produce a sign-in-able
 * account with the must-change flag set.
 */
import "server-only";
import { db, unwrap } from "../supabase/server";
import type { AppUser, UserRole } from "../types";

export interface PersonRow extends AppUser {
  created_at: string;
  /** LIVE assessment for the current cycle, if they have one */
  assessment_id: string | null;
  assessment_state: string | null;
  scored: number;
  /**
   * When this person last scored anything, or null if never. Completion alone
   * cannot tell a person who is 40% through and moving from one who stopped
   * three weeks ago — this is what separates them (D16).
   *
   * ONLY MEANINGFUL WHILE THE ASSESSMENT IS A DRAFT. `score.updated_at` is
   * bumped by any upsert, and three assessor-side paths write score rows — the
   * submit prefill, saveRevisions and accept-all. After submission this would
   * report the ASSESSOR's activity under the PM's name, so the screen shows it
   * only for drafts, which is also the only state that can stall.
   */
  last_scored: string | null;
  /**
   * Most recent ARCHIVED assessment for the cycle. Carried separately rather
   * than folded into the fields above: this screen is the only place an
   * archived record is still visible, so it is also the only place it can be
   * restored from.
   */
  archived_id: string | null;
  archived_reason: string | null;
  archived_at: string | null;
}

const COLUMNS = "id, email, full_name, job_title, role, must_change_password, created_at";

/** Everyone on the allowlist, with their assessment for the cycle if any. */
export async function listPeople(cycle: string): Promise<PersonRow[]> {
  const sb = db();
  const people = unwrap(
    "people list",
    await sb.from("app_user").select(COLUMNS).order("role").order("full_name"),
  ) as (AppUser & { created_at: string })[];
  if (people.length === 0) return [];

  const [assessments, archivedRows] = await Promise.all([
    sb.from("assessment")
      .select("id, assessee_id, state")
      .eq("cycle", cycle)
      .is("archived_at", null)
      .in("assessee_id", people.map((p) => p.id))
      .then((r) => unwrap("assignment lookup", r) as { id: string; assessee_id: string; state: string }[]),
    sb.from("assessment")
      .select("id, assessee_id, archived_at, archived_reason")
      .eq("cycle", cycle)
      .not("archived_at", "is", null)
      .order("archived_at", { ascending: false })
      .in("assessee_id", people.map((p) => p.id))
      .then((r) => unwrap("archive lookup", r) as {
        id: string; assessee_id: string; archived_at: string; archived_reason: string | null;
      }[]),
  ]);

  const byPerson = new Map(assessments.map((a) => [a.assessee_id, a]));
  // Ordered newest-first, so the first one seen per person is the latest.
  const archivedByPerson = new Map<string, (typeof archivedRows)[number]>();
  for (const a of archivedRows) {
    if (!archivedByPerson.has(a.assessee_id)) archivedByPerson.set(a.assessee_id, a);
  }

  /* A failed read here used to render as zeroes: everyone "0 scored", everyone
     "not started", and hasStalled silently false for the whole team — a
     plausible, entirely wrong page with nothing to say it had failed. That is
     the N19 mistake in a different table, so it throws now.
     Also skipped entirely when nothing is assigned, which is the normal state
     at the start of a cycle and was costing an `.in(…, [])` round trip. */
  const scores = assessments.length === 0 ? [] : (
    unwrap("score tally", await sb
      .from("score")
      // updated_at rides along with the rows already being counted, so the
      // last-activity column costs no extra query — deliberately not one
      // aggregate per person.
      .select("assessment_id, self_level, updated_at")
      .in("assessment_id", assessments.map((a) => a.id))
      .not("self_level", "is", null)
      .limit(20000))
  ) as { assessment_id: string; updated_at: string | null }[];

  const scoredCount = new Map<string, number>();
  const lastScored = new Map<string, string>();
  for (const s of scores) {
    scoredCount.set(s.assessment_id, (scoredCount.get(s.assessment_id) ?? 0) + 1);
    const at = s.updated_at;
    const held = lastScored.get(s.assessment_id);
    // Compare instants rather than strings: lexicographic ISO ordering holds
    // only while every row carries the same UTC offset, which is a property of
    // the connection, not of the data.
    if (at && (!held || Date.parse(at) > Date.parse(held))) {
      lastScored.set(s.assessment_id, at);
    }
  }

  return people.map((p) => {
    const a = byPerson.get(p.id);
    const gone = archivedByPerson.get(p.id);
    return {
      ...p,
      assessment_id: a?.id ?? null,
      assessment_state: a?.state ?? null,
      scored: a ? scoredCount.get(a.id) ?? 0 : 0,
      last_scored: a ? lastScored.get(a.id) ?? null : null,
      archived_id: gone?.id ?? null,
      archived_reason: gone?.archived_reason ?? null,
      archived_at: gone?.archived_at ?? null,
    };
  });
}

/**
 * The auth user id for an email, or null.
 *
 * Supabase's admin API has no get-by-email, so this pages through listUsers.
 * Paged rather than a single perPage=1000 call because "the address is taken
 * but I cannot find it" is exactly the dead end this exists to remove, and a
 * silent truncation at user 1001 would recreate it in a form that only appears
 * once the organisation is large.
 */
async function findAuthUserByEmail(
  sb: ReturnType<typeof db>,
  email: string,
): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const users = data?.users ?? [];
    const hit = users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < 200) return null;
  }
  return null;
}

/**
 * Create an account. The password is chosen by the admin and is valid for
 * exactly one sign-in: `must_change_password` forces the user to replace it,
 * which is what stops an admin (who is also the assessor here) from being able
 * to sign in and enter someone else's SELF-assessment.
 */
export async function addPerson(input: {
  email: string;
  full_name: string;
  job_title: string | null;
  role: UserRole;
  password: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) return { ok: false, error: "That does not look like an email address." };
  if (!input.full_name.trim()) return { ok: false, error: "A full name is required." };
  if (input.password.length < 10) return { ok: false, error: "The password needs at least 10 characters." };

  const sb = db();

  const existing = await sb.from("app_user").select("id").eq("email", email).maybeSingle();
  if (existing.data) return { ok: false, error: `${email} is already on the allowlist.` };

  const created = await sb.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.full_name.trim() },
  });

  /**
   * An ORPHAN: a sign-in account with no allowlist row.
   *
   * We already know there is no `app_user` row for this address — that was
   * checked above — so "already registered" means the two halves of an account
   * have come apart. It happens when a previous add failed part-way, or when a
   * removal took the allowlist row without the sign-in account.
   *
   * Before this, that was a dead end with no route out of the UI: the admin was
   * told the address was taken, while the People list showed nobody by that
   * name. The owner hit it trying to add a real person. The only fix was a
   * database console.
   *
   * So adopt it. An orphaned account holds NO access — `app_user` IS the
   * allowlist, and without a row it can sign in and reach nothing — so writing
   * the row and setting the password the admin just typed is precisely what
   * "add this person" was asking for. It cannot be used to hijack a live
   * account, because a live account has an `app_user` row and was refused
   * above.
   */
  let userId = created.data.user?.id;
  if (created.error) {
    const orphan = await findAuthUserByEmail(sb, email);
    if (!orphan) {
      return { ok: false, error: created.error.message };
    }
    const adopted = await sb.auth.admin.updateUserById(orphan, {
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.full_name.trim() },
    });
    if (adopted.error) {
      return {
        ok: false,
        error: `${email} has a sign-in account that could not be reclaimed: ${adopted.error.message}`,
      };
    }
    userId = orphan;
  }
  if (!userId) {
    return { ok: false, error: "Could not create the sign-in account." };
  }

  const row = await sb.from("app_user").insert({
    id: userId,
    email,
    full_name: input.full_name.trim(),
    job_title: input.job_title?.trim() || null,
    role: input.role,
    must_change_password: true,
  });
  if (row.error) {
    // Never leave a sign-in account without an allowlist row: it would be an
    // authenticated identity that the app refuses, with no way to see why.
    // Only when we made it. Deleting an account we merely adopted would destroy
    // something that existed before this request — and leaving it costs nothing,
    // since an orphan holds no access and the next attempt adopts it again.
    if (created.data.user) await sb.auth.admin.deleteUser(created.data.user.id);
    return { ok: false, error: `Could not add them to the allowlist: ${row.error.message}` };
  }

  return { ok: true };
}

/** Admin password reset. Same one-sign-in contract as creation. */
export async function resetPassword(
  userId: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (password.length < 10) return { ok: false, error: "The password needs at least 10 characters." };

  const sb = db();
  const updated = await sb.auth.admin.updateUserById(userId, { password, email_confirm: true });
  if (updated.error) return { ok: false, error: updated.error.message };

  const flagged = await sb
    .from("app_user")
    .update({ must_change_password: true })
    .eq("id", userId)
    .select("id");
  if (flagged.error) return { ok: false, error: flagged.error.message };
  if ((flagged.data ?? []).length === 0) {
    return { ok: false, error: "That account is not on the allowlist." };
  }

  return { ok: true };
}

/** How many live assessments a person holds — the guard before removing them. */
export async function assessmentCount(userId: string): Promise<number> {
  const { count } = await db()
    .from("assessment")
    .select("*", { count: "exact", head: true })
    .eq("assessee_id", userId)
    .is("archived_at", null);
  return count ?? 0;
}
