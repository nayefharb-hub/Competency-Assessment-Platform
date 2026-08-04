"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { THEME_COOKIE, type Theme } from "./theme";

/**
 * Store the theme choice. Not httpOnly: nothing here is a secret, and a future
 * client-side flash-preventer would need to read it.
 */
export async function setThemeAction(formData: FormData): Promise<void> {
  const raw = String(formData.get("theme") ?? "system");
  const theme: Theme =
    raw === "light" || raw === "dark" || raw === "system" ? raw : "system";

  const store = await cookies();
  store.set(THEME_COOKIE, theme, {
    path: "/",
    maxAge: 400 * 24 * 60 * 60,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  revalidatePath("/", "layout");
}
