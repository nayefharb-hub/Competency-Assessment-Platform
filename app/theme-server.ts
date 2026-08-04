import "server-only";
import { cookies } from "next/headers";
import { asTheme, THEME_COOKIE, type Theme } from "./theme";

/**
 * The stored choice, read on the server so the very first paint is already the
 * right theme. Without this the page would render light and flip to dark after
 * hydration, which is worse than not having a toggle.
 */
export async function currentTheme(): Promise<Theme> {
  return asTheme((await cookies()).get(THEME_COOKIE)?.value);
}
