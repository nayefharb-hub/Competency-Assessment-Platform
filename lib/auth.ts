/**
 * Invite-only authentication.
 *
 * Public signup is disabled in the Supabase project; accounts are created by an
 * admin (scripts/invite.mjs), which writes both the auth.users row and the
 * public.app_user row. `app_user` IS the allowlist: a valid Supabase session
 * with no matching app_user row gets no access at all. That keeps the pilot's
 * "invited emails only" rule in one place rather than scattered across routes.
 *
 * Sessions ride in cookies managed by @supabase/ssr with the anon key. The anon
 * key can read nothing (RLS on, zero policies, privileges revoked) — every table
 * read goes through the service-role client in lib/supabase/server.
 */
import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { db, supabaseAnonKey, supabaseUrl, timedSupabaseFetch } from "./supabase/server";
import { phase } from "./perf";
import { SESSION_COOKIE } from "./supabase/cookies";
import { TTLMap } from "./ttl-map";
import type { AppUser, UserRole } from "./types";

/** Auth-only client bound to the request's cookie jar. */
export const authClient = cache(async function authClient() {
  const store = await cookies();
  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    // Timed like the service client: auth.getUser() is a network round trip to
    // Supabase Auth on every authenticated render, and it needs to be visible
    // alongside the database calls rather than hiding among them.
    global: { fetch: timedSupabaseFetch("auth") },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) {
            store.set(name, value, { ...options, ...SESSION_COOKIE });
          }
        } catch {
          // Called from a server component, where cookies are read-only. The
          // middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
});

/**
 * The columns that make an AppUser. Kept in one constant because this list is a
 * silent-failure surface: a column added to the table but forgotten here reads
 * back as `undefined`, and for a boolean flag that means falsy — a gate that
 * never fires, with nothing thrown anywhere. `must_change_password` is exactly
 * that shape, so it lives here and nowhere else.
 */
const APP_USER_COLUMNS =
  "id, email, full_name, job_title, role, must_change_password";

/**
 * Who is asking — resolved ONCE per render.
 *
 * `cache()` is React's per-request memo, and it is load-bearing here rather
 * than a nicety. Every page render used to do this work twice: the layout calls
 * currentUser() to draw the header, and the page itself calls requireUser().
 * Each was a network round trip to Supabase Auth to validate the token PLUS an
 * app_user query — four calls where two will do, on every single navigation.
 *
 * Three states rather than a nullable user, because the two failure modes need
 * different answers: no session goes to /login, while a valid session with no
 * allowlist row goes to /logout, which clears it. Collapsing them to null was
 * what forced the two callers to duplicate the lookup in the first place.
 */
type Viewer =
  | { status: "anon" }
  | { status: "uninvited" }
  /**
   * The allowlist could not be READ. Distinct from "uninvited" because the
   * answers are opposite: an uninvited account must be signed out, and a failed
   * query must not be, or one slow moment on the database logs a legitimate
   * user out and tells them they were never invited.
   *
   * That is not hypothetical. The owner hit exactly this refreshing the page
   * after a deployment — signed in as the admin, on the allowlist, and shown
   * "That account is not on the assessment allowlist." The session was gone.
   * `row.error` and `!row.data` were the same branch, and on a t3a.nano under
   * cold-start load a transient failure is an ordinary event.
   */
  | { status: "unavailable"; message: string }
  | { status: "ok"; user: AppUser };

/**
 * Cross-pass memo for the resolved viewer (eng-plan-save-latency, A2).
 *
 * React's `cache()` above dedupes WITHIN one render pass. A server action and
 * the render of its redirect target are two passes of the same POST, so every
 * save paid for authentication twice. This memo bridges exactly that gap.
 *
 * This is the argued exception to the Fluid Compute rule "no per-user state
 * at module scope" (docs/deploy.md). Why it cannot leak or lie:
 * - keyed by the FULL access token — two users share an entry only if they
 *   share a token, which is theft, not a collision;
 * - only `status: "ok"` is stored. `unavailable` is never replayed (N19:
 *   a transient DB failure must stay transient), `anon`/`uninvited` are
 *   cheap to recompute and dangerous to cache;
 * - 2s TTL spans action→render of one request, not two human interactions;
 *   LRU cap 200. signOut() deletes the entry (review D3) — in THIS instance
 *   only: under Fluid a sibling instance that resolved the same token seconds
 *   earlier still answers from its own map until the 2s expires.
 * - staleness bound: a role or must_change_password flip lands within 2s.
 */
const viewerMemo = new TTLMap<string, Viewer>(2_000, 200);

const viewer = cache(async function viewer(): Promise<Viewer> {
  return phase("auth: validate token + load app_user", async () => {
  const auth = await authClient();

  // The raw token, read from the cookie without a network call. It is both
  // the memo key and the thing getClaims() verifies.
  const { data: sess } = await auth.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { status: "anon" };

  const memoized = viewerMemo.get(token);
  if (memoized) return memoized;

  // Local signature verification (A1). The project signs sessions with ES256
  // (verified 2026-08-05), so this is CPU + a module-globally cached JWKS —
  // no auth round trip. Every failure path inside getClaims (alg:none, HS*
  // downgrade, unknown kid, missing WebCrypto) falls back to a server-side
  // getUser() — verified in auth-js 2.112.0 source — so forged headers
  // degrade to the slow path, never to trust.
  const { data: verified, error } = await auth.auth.getClaims();
  if (error || !verified) return { status: "anon" };

  // /cso hardening: only a real session token names an authenticated user.
  // The allowlist below would refuse a non-user token anyway (no app_user
  // row for a sub it doesn't have) — this makes the intent explicit.
  const claims = verified.claims;
  if (claims.role !== "authenticated" || !claims.sub) return { status: "anon" };

  const row = await db()
    .from("app_user")
    .select(APP_USER_COLUMNS)
    .eq("id", claims.sub)
    .maybeSingle();

  // The query FAILED — we do not know whether they are invited, so we must not
  // act as though we do. Logged loudly: the original bug was undiagnosable
  // precisely because this path was silent, and a log line is what turns the
  // next occurrence into evidence instead of a screenshot.
  if (row.error) {
    console.error(`[auth] app_user lookup failed: ${row.error.message}`);
    return { status: "unavailable", message: row.error.message };
  }
  // Queried successfully, and there is genuinely no row: an uninvited account.
  if (!row.data) return { status: "uninvited" };
  const ok: Viewer = { status: "ok", user: row.data as AppUser };
  viewerMemo.set(token, ok);
  return ok;
  });
});

/** The signed-in, invited user — or null. Never throws for "not logged in". */
export async function currentUser(): Promise<AppUser | null> {
  const v = await viewer();
  return v.status === "ok" ? v.user : null;
}

/**
 * The message shown when the allowlist cannot be read.
 *
 * Deliberately says "try again": the session is intact, so a refresh genuinely
 * is the fix. The old behaviour told the user the opposite — that they had
 * never been invited — which is both wrong and unrecoverable, since it took
 * their session with it.
 */
const UNAVAILABLE =
  "Could not reach the database to confirm your account. Your session is still valid — please try again.";

/**
 * A signed-in account that is NOT on the allowlist is sent to /logout, which
 * clears the session and returns it to the sign-in page with an explanation.
 * Without that, such an account would hold a valid session forever and bounce
 * between the app and /login.
 */
export async function requireUser(
  opts: {
    /**
     * Only /change-password passes this. That page needs the signed-in user,
     * so it has to call requireUser — and if requireUser bounced it to
     * /change-password the redirect would be infinite. Exactly the shape of the
     * /logout bounce below, which is why it is a named option rather than an
     * implicit exception someone can delete by accident.
     */
    skipPasswordGate?: boolean;
  } = {},
): Promise<AppUser> {
  const v = await viewer();
  if (v.status === "anon") redirect("/login");
  if (v.status === "uninvited") redirect("/logout?denied=1");
  // Throws rather than redirecting: every redirect target here either signs the
  // user out or is itself a page that must resolve the viewer, so redirecting
  // on a database failure would either destroy a good session or loop. An error
  // page keeps the session and a refresh recovers.
  if (v.status === "unavailable") throw new Error(UNAVAILABLE);

  const user = v.user;

  // The password gate. Server-side on purpose: it cannot live in proxy.ts,
  // which runs on the edge holding only the anon key and cannot read app_user
  // at all. A client-side nudge would be decorative — someone could type
  // /assess and be scoring against a password an admin chose and still knows.
  if (user.must_change_password && !opts.skipPasswordGate) {
    redirect("/change-password");
  }

  return user;
}

/** Role gate. `assessor` and `admin` are both held by the Head of PMO today. */
export async function requireRole(...roles: UserRole[]): Promise<AppUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/?denied=1");
  return user;
}

export function canAssess(user: AppUser): boolean {
  return user.role === "assessor" || user.role === "admin";
}

export function canAdmin(user: AppUser): boolean {
  return user.role === "admin";
}

/**
 * Forget this session's cached viewer (N45).
 *
 * THE BUG THIS EXISTS FOR. `viewerMemo` is keyed by access token and lives 2s.
 * A server action that CHANGES the viewer — today only the password change,
 * which clears `must_change_password` — populates that memo on its way in, via
 * its own `requireUser()`, with the pre-change value. It then writes the new
 * value to Postgres and redirects. The redirect's render is a second pass of
 * the same request, well inside 2s, so it answers from the memo and sees the
 * OLD flag. The gate at `requireUser` then bounces the PM back to the screen
 * they just completed, with no explanation, on the first thing they ever do in
 * this app.
 *
 * `signOut()` below has always done this, for exactly this reason. The password
 * change never got the same treatment; that asymmetry was N45.
 *
 * CALL IT AFTER THE WRITE, NOT BEFORE. Evicting first would leave the window
 * between eviction and write open for any concurrent pass to re-populate the
 * memo with the stale value — which is the same race in a smaller box.
 *
 * WHAT IT DOES NOT FIX, stated plainly because the fix reads stronger than it
 * is: under Fluid Compute a SIBLING instance that resolved the same token
 * seconds earlier still answers from its own map until the 2s expires. This
 * narrows the window to that bound; it does not close it. Closing it would mean
 * shared invalidation, which is a network hop on the hot path and is precisely
 * the trade `docs/deploy.md` argues against for a 2s staleness bound.
 */
export async function forgetViewer(): Promise<void> {
  const auth = await authClient();
  const { data } = await auth.auth.getSession();
  // Read AFTER any credential change, so this is whatever token the redirect's
  // render will actually present. If Supabase rotated the token, the old entry
  // is keyed by a token that render will never show, so it cannot mislead it.
  if (data.session?.access_token) viewerMemo.delete(data.session.access_token);
}

export async function signOut(): Promise<void> {
  const auth = await authClient();
  // Purge BEFORE revoking (review D3): without this, a captured token would
  // skip even the allowlist check for up to 2s after logout.
  const { data } = await auth.auth.getSession();
  if (data.session?.access_token) viewerMemo.delete(data.session.access_token);
  await auth.auth.signOut();
}
