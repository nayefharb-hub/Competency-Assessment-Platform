"use server";

import { redirect } from "next/navigation";
import { authClient } from "@/lib/auth";
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
  const invited = await db()
    .from("app_user")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (invited.error || !invited.data) return { error: GENERIC, email };

  const auth = await authClient();
  const { error } = await auth.auth.signInWithPassword({ email, password });
  if (error) return { error: GENERIC, email };

  // Only ever bounce to an in-app path. `//host` and `/\host` are both read as
  // protocol-relative by browsers, so a bare startsWith("/") is not enough.
  const safe = /^\/(?![/\\])/.test(next) ? next : "/";
  redirect(safe);
}
