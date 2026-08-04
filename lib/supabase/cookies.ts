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
 * Not addressed here because it is a Supabase project setting, not code: the
 * refresh token has no inactivity timeout or absolute time-box, so a session
 * renews indefinitely while it is being used. See docs/deploy.md.
 */
export const SESSION_COOKIE = {
  httpOnly: true,
  // Local development is http://127.0.0.1, where a Secure cookie is discarded.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
} as const;
