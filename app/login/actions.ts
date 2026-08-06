"use server";

import { redirect } from "next/navigation";
import { authClient } from "@/lib/auth";
import { ASSESS_HUB } from "@/lib/routes";
import { db } from "@/lib/supabase/server";

/** One message for every failure — see the note on the sign-in page. */
const GENERIC = "Email or password not recognised, or that account has not been invited.";

export interface SignInState {
  error?: string;
  /** What they actually typed, so the form can put it back (N23). */
  email?: string;
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
 */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (!email || !password) return { error: GENERIC, email };

  // Allowlist first: app_user is the invitation list, so an account that Supabase
  // Auth would happily authenticate still gets no session if it is not invited.
  // `role` rides along on a select that already runs — no extra round trip on
  // the sign-in path. It decides the landing below.
  const invited = await db()
    .from("app_user")
    .select("id, role")
    .eq("email", email)
    .maybeSingle();
  if (invited.error || !invited.data) return { error: GENERIC, email };

  const auth = await authClient();
  const { error } = await auth.auth.signInWithPassword({ email, password });
  if (error) return { error: GENERIC, email };

  // Only ever bounce to an in-app path. `//host` and `/\host` are both read as
  // protocol-relative by browsers, so a bare startsWith("/") is not enough.
  const safe = /^\/(?![/\\])/.test(next) ? next : "/";

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
