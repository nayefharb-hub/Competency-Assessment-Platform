/**
 * Theme constants — shared by the server (which reads the cookie to render the
 * right theme on first paint) and the browser (which writes it).
 *
 * Deliberately free of `server-only` and of `next/headers`: a client component
 * imports this, and either would make it un-importable there.
 */
export type Theme = "system" | "light" | "dark";
export const THEME_COOKIE = "cap-theme";
export const THEME_MAX_AGE = 400 * 24 * 60 * 60;

export function asTheme(value: string | undefined): Theme {
  return value === "light" || value === "dark" ? value : "system";
}
