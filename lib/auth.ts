/**
 * Invite-only authentication.
 *
 * Public signup is disabled in the Supabase project; accounts are created by an
 * admin (scripts/invite.mjs), which writes both the auth.users row and the
 * public.app_user row. `app_user` IS the allowlist: a valid Supabase session
 * with no matching app_user row gets no access at all. That keeps the pilot's
 * "invited emails only" rule in one place rather than scattered across routes.
 *
 * Sessions ride in httpOnly cookies managed by @supabase/ssr with the anon key.
 * The anon key can read nothing (RLS on, zero policies, privileges revoked) —
 * every table read goes through the service-role client in lib/supabase/server.
 */
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { db, supabaseAnonKey, supabaseUrl } from "./supabase/server";
import type { AppUser, UserRole } from "./types";

/** Auth-only client bound to the request's cookie jar. */
export async function authClient() {
  const store = await cookies();
  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a server component, where cookies are read-only. The
          // middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

/** The signed-in, invited user — or null. Never throws for "not logged in". */
export async function currentUser(): Promise<AppUser | null> {
  const auth = await authClient();
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) return null;

  const row = await db()
    .from("app_user")
    .select("id, email, full_name, job_title, role")
    .eq("id", data.user.id)
    .maybeSingle();

  // A session without an app_user row is an uninvited account: deny.
  if (row.error || !row.data) return null;
  return row.data as AppUser;
}

/**
 * A signed-in account that is NOT on the allowlist is sent to /logout, which
 * clears the session and returns it to the sign-in page with an explanation.
 * Without that, such an account would hold a valid session forever and bounce
 * between the app and /login.
 */
export async function requireUser(): Promise<AppUser> {
  const auth = await authClient();
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) redirect("/login");

  const row = await db()
    .from("app_user")
    .select("id, email, full_name, job_title, role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (row.error || !row.data) redirect("/logout?denied=1");
  return row.data as AppUser;
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

export async function signOut(): Promise<void> {
  const auth = await authClient();
  await auth.auth.signOut();
}
