/**
 * Theme choice (N12) — the shared bits.
 *
 * Separate from theme-actions.ts because a `"use server"` module may export
 * ONLY async functions; a type or a constant alongside the action makes the
 * whole file fail to compile.
 *
 * A cookie rather than a column on app_user, deliberately. It has to work on
 * /login, where there is no user to hang a preference on, and "which screen am
 * I looking at this on" is a property of the device rather than the person.
 * It also keeps the app free of client components, which is what lets the
 * session cookie stay httpOnly (see lib/supabase/cookies.ts).
 */
import "server-only";
import { cookies } from "next/headers";

export type Theme = "system" | "light" | "dark";
export const THEME_COOKIE = "cap-theme";

/** The stored choice, or "system" when nothing has been chosen. */
export async function currentTheme(): Promise<Theme> {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  return value === "light" || value === "dark" ? value : "system";
}
