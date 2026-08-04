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
      .is("deleted_at", null)
      .in("assessee_id", people.map((p) => p.id))
      .then((r) => (r.data ?? []) as { id: string; assessee_id: string; state: string }[]),
    sb.from("assessment")
      .select("id, assessee_id, deleted_at, deleted_reason")
      .eq("cycle", cycle)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .in("assessee_id", people.map((p) => p.id))
      .then((r) => (r.data ?? []) as {
        id: string; assessee_id: string; deleted_at: string; deleted_reason: string | null;
      }[]),
  ]);

  const byPerson = new Map(assessments.map((a) => [a.assessee_id, a]));
  // Ordered newest-first, so the first one seen per person is the latest.
  const archivedByPerson = new Map<string, (typeof archivedRows)[number]>();
  for (const a of archivedRows) {
    if (!archivedByPerson.has(a.assessee_id)) archivedByPerson.set(a.assessee_id, a);
  }

  const scores = (
    await sb
      .from("score")
      .select("assessment_id, self_level")
      .in("assessment_id", assessments.map((a) => a.id))
      .not("self_level", "is", null)
      .limit(20000)
  ).data as { assessment_id: string }[] | null;

  const scoredCount = new Map<string, number>();
  for (const s of scores ?? []) {
    scoredCount.set(s.assessment_id, (scoredCount.get(s.assessment_id) ?? 0) + 1);
  }

  return people.map((p) => {
    const a = byPerson.get(p.id);
    const gone = archivedByPerson.get(p.id);
    return {
      ...p,
      assessment_id: a?.id ?? null,
      assessment_state: a?.state ?? null,
      scored: a ? scoredCount.get(a.id) ?? 0 : 0,
      archived_id: gone?.id ?? null,
      archived_reason: gone?.deleted_reason ?? null,
      archived_at: gone?.deleted_at ?? null,
    };
  });
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
  if (created.error || !created.data.user) {
    return { ok: false, error: created.error?.message ?? "Could not create the sign-in account." };
  }

  const row = await sb.from("app_user").insert({
    id: created.data.user.id,
    email,
    full_name: input.full_name.trim(),
    job_title: input.job_title?.trim() || null,
    role: input.role,
    must_change_password: true,
  });
  if (row.error) {
    // Never leave a sign-in account without an allowlist row: it would be an
    // authenticated identity that the app refuses, with no way to see why.
    await sb.auth.admin.deleteUser(created.data.user.id);
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
    .is("deleted_at", null);
  return count ?? 0;
}
