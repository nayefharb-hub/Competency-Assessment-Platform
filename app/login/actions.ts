"use server";

import { redirect } from "next/navigation";
import { authClient } from "@/lib/auth";
import { db } from "@/lib/supabase/server";

/** One message for every failure — see the note on the sign-in page. */
const GENERIC = "Email or password not recognised, or that account has not been invited.";

export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (!email || !password) redirect(`/login?error=${encodeURIComponent(GENERIC)}`);

  // Allowlist first: app_user is the invitation list, so an account that Supabase
  // Auth would happily authenticate still gets no session if it is not invited.
  const invited = await db()
    .from("app_user")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (invited.error || !invited.data) redirect(`/login?error=${encodeURIComponent(GENERIC)}`);

  const auth = await authClient();
  const { error } = await auth.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?error=${encodeURIComponent(GENERIC)}`);

  // Only ever bounce to an in-app path. `//host` and `/\host` are both read as
  // protocol-relative by browsers, so a bare startsWith("/") is not enough.
  const safe = /^\/(?![/\\])/.test(next) ? next : "/";
  redirect(safe);
}
