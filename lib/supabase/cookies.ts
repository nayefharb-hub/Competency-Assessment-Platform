/**
 * Session cookie hardening.
 *
 * @supabase/ssr defaults to `httpOnly: false` and sets no `secure` flag
 * (see DEFAULT_COOKIE_OPTIONS in the package). `httpOnly: false` is deliberate
 * on their side: the browser-side supabase-js client has to be able to read the
 * session. THIS APP HAS NO BROWSER-SIDE CLIENT — no `createBrowserClient`, no
 * `"use client"` component anywhere; every Supabase call is server-side — so we
 * were exposing the session to page JavaScript to buy a capability we do not
 * use. Any XSS on the origin could read the token and replay it elsewhere.
 *
 * Spread these AFTER the library's own options so they win.
 *
 * IF A CLIENT COMPONENT EVER NEEDS THE SUPABASE SESSION, this is the thing that
 * will break, and it should be argued about rather than quietly reverted: the
 * server-only architecture is what makes httpOnly free.
 *
 * SESSION LIFETIME (owner policy, 2026-08-12). @supabase/ssr defaults the cookie
 * to a 400-day maxAge, re-issued on every refresh — an effectively permanent
 * session. `SESSION_MAX_AGE` below caps that as a rolling IDLE timeout: because
 * proxy.ts re-sets the cookie whenever it refreshes the token, the maxAge clock
 * restarts on activity, so an unused session dies after `SESSION_MAX_AGE`.
 * MUST stay comfortably above the access-token TTL (≥2×), or an *active* user's
 * cookie can lapse between refreshes; 8h against a ≤1h token has ample headroom.
 * The idle cap's authoritative twin is the Supabase "inactivity timeout" project
 * setting; this cookie is the browser-side backstop (see docs/deploy.md).
 *
 * The ABSOLUTE cap (a hard ceiling regardless of activity) can't be a rolling
 * maxAge — it would reset on refresh too. It lives in a SEPARATE, never-rolled
 * marker cookie (`SESSION_START_COOKIE`) set once at login with a fixed
 * `ABSOLUTE_SESSION_MAX_AGE`; lib/auth.ts treats "live token, marker gone" as
 * expired. @supabase/ssr only manages `sb-*` cookies, so it never touches it.
 */
export const SESSION_MAX_AGE = 60 * 60 * 8; // 8h rolling idle timeout
export const ABSOLUTE_SESSION_MAX_AGE = 60 * 60 * 12; // 12h hard ceiling

export const SESSION_COOKIE = {
  httpOnly: true,
  // Local development is http://127.0.0.1, where a Secure cookie is discarded.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_MAX_AGE,
} as const;

/** The absolute-cap marker: set once at login, never rolled. Same hardening. */
export const SESSION_START_COOKIE = "cap.sess_start";
export const SESSION_START_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: ABSOLUTE_SESSION_MAX_AGE,
} as const;
