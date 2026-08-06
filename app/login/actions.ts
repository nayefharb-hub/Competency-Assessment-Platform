"use server";

import { redirect } from "next/navigation";
import { authClient } from "@/lib/auth";
import { ASSESS_HUB, safeNext } from "@/lib/routes";
import { db } from "@/lib/supabase/server";

/** One message for every failure — see the note on the sign-in page. */
const GENERIC = "Email or password not recognised, or that account has not been invited.";

export interface SignInState {
  error?: string;
  /** What they actually typed, so the form can put it back (N23). */
  email?: string;
}

/**
 * Long enough to cover both branches with headroom (the slower was ~249ms when
 * measured from outside the region; production runs in the same region as the
 * database and is faster). Short enough that a mistyped password does not feel
 * broken. See the note on signIn for what this defends.
 */
const FAILURE_FLOOR_MS = 600;

/** One refusal, one duration, whatever the reason underneath. */
async function refuse(startedAt: number, email: string): Promise<SignInState> {
  const spent = Date.now() - startedAt;
  if (spent < FAILURE_FLOOR_MS) {
    await new Promise((resolve) => setTimeout(resolve, FAILURE_FLOOR_MS - spent));
  }
  return { error: GENERIC, email };
}

/**
 * Sign in — returns failure, redirects on success.
 *
 * WHY IT RETURNS RATHER THAN REDIRECTS ON FAILURE (N23). It used to bounce to
 * `/login?error=…`, which is a fresh render with an empty field; the browser's
 * own autofill then supplied the previously saved address. Nothing in the app
 * wrote that value, but the person saw the address they had NOT typed and read
 * it as the app replacing their input — and, worse, could no longer see their
 * own typo. Returning the typed address keeps it on screen.
 *
 * It also removes the last writer of `/login?error=`, and with it a reflection
 * surface: any text in that parameter rendered inside the app's own error
 * banner, at the real origin, on a page that asks for a password. React
 * escapes it, so this was phishing rather than XSS — still worth deleting.
 *
 * The message stays IDENTICAL for wrong password, no such account, and not
 * invited. Distinguishing them would let an outsider enumerate the pilot's
 * staff list one address at a time.
 *
 * WHY THE ALLOWLIST IS CHECKED SECOND, AND WHY FAILURE HAS A FLOOR (/cso
 * finding 2, 2026-08-06). The identical message used to be undone by the clock.
 * The allowlist select ran FIRST and returned on a miss, so an uninvited address
 * never reached signInWithPassword and came back roughly a quarter of a second
 * sooner than an invited one. Measured against the live project: the password
 * verification the fast path skipped cost ~249ms median against ~135ms for an
 * address with no account at all. An attacker posts candidate addresses with any
 * password, times the replies, and reads the pilot's roster off the difference —
 * no password guessed, and no auth rate limit touched, because the fast path
 * never reached Supabase Auth.
 *
 * So the password is now verified FIRST, for every address, and the allowlist is
 * consulted afterwards. Round trips are unchanged on the success path (two
 * either way) and one FEWER on a wrong password.
 *
 * The floor covers what reordering cannot. Supabase Auth is itself measurably
 * slower for an address it knows than one it does not, and in this app knowing
 * the address and being on the allowlist are the same fact, so the oracle would
 * survive at reduced volume. Padding every refusal to a fixed minimum flattens
 * it. It is a floor rather than a fixed duration: a refusal already slower than
 * FAILURE_FLOOR_MS is not padded, so a loaded database can still leak a little.
 * Closing that completely means answering on a timer regardless of when the work
 * finishes, which costs every honest typo the full delay.
 */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  // Not padded: this answer depends on nothing but what the caller sent, so it
  // discloses nothing about who exists. Padding it would only make an empty
  // field feel slow.
  if (!email || !password) return { error: GENERIC, email };

  const startedAt = Date.now();

  // The password is verified for EVERY address, invited or not. That is what
  // makes the two outcomes cost the same; see the note above.
  const auth = await authClient();
  const { error } = await auth.auth.signInWithPassword({ email, password });
  if (error) return refuse(startedAt, email);

  // Now the allowlist. app_user is the invitation list, so an account Supabase
  // Auth was happy to authenticate still gets no session if it is not invited —
  // and the session just created has to be thrown away, or an uninvited account
  // would leave here holding a cookie. `role` rides along and decides the
  // landing below.
  const invited = await db()
    .from("app_user")
    .select("id, role")
    .eq("email", email)
    .maybeSingle();
  if (invited.error || !invited.data) {
    await auth.auth.signOut();
    return refuse(startedAt, email);
  }

  // Only ever bounce to an in-app path. See safeNext: the old inline regex let
  // "/\t/evil.com" through, which the browser resolves to https://evil.com/.
  const safe = safeNext(next);

  /* Land by role, AT SIGN-IN — which is what D32 asks for, and deliberately
     not a redirect on `/`.
     Redirecting an assessee off `/` on every visit was the first design, and
     it silently ate the one explanation a blocked person ever gets: requireRole
     bounces to `/?denied=1` and the console renders that banner. A PM following
     a colleague's link to /review would have landed on the hub with no idea
     why. /login already carries the same exemption for the same reason.
     Doing it here removes the mechanism instead of patching around it: `/` stays
     reachable by anyone who navigates or is bounced there, and the banner
     cannot stop rendering.
     Only the bare default is overridden. An explicit `next` — the path someone
     was trying to reach before being asked to sign in — always wins. */
  const landing = safe === "/" && invited.data.role === "assessee" ? ASSESS_HUB : safe;
  redirect(landing);
}
