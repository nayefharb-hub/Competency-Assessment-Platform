"use client";

import { useState } from "react";
import { THEME_COOKIE, THEME_MAX_AGE, type Theme } from "./theme";

const OPTIONS: { value: Theme; label: string; title: string }[] = [
  { value: "light", label: "Light", title: "Always use the light theme" },
  { value: "dark", label: "Dark", title: "Always use the dark theme" },
  { value: "system", label: "Auto", title: "Match this device's setting" },
];

/**
 * Light / Dark / Auto (N12).
 *
 * The app's only client component, and it earns that on the numbers. It was a
 * server action first, which meant every click wrote a cookie and then called
 * revalidatePath("/", "layout") — the theme lives on <html>, so the whole tree
 * had to re-render for the change to show. The cookie write is free; the
 * re-render costs a full page load, and the owner measured 3-4 seconds for what
 * is visually an attribute flip.
 *
 * A theme is a browser concern. Setting the attribute is instant and involves
 * no server at all; the cookie is written the same way, and exists only so the
 * SERVER can render the right theme on the next first paint and avoid a flash.
 *
 * This does not weaken the session cookie's httpOnly flag — that holds because
 * nothing in the browser reads the SESSION, which is still true.
 */
export default function ThemeToggle({ current }: { current: Theme }) {
  const [theme, setTheme] = useState<Theme>(current);

  function choose(next: Theme) {
    document.documentElement.dataset.theme = next;
    document.cookie =
      `${THEME_COOKIE}=${next}; path=/; max-age=${THEME_MAX_AGE}; samesite=lax` +
      (location.protocol === "https:" ? "; secure" : "");
    setTheme(next);
  }

  return (
    <div className="themetoggle segmented" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={theme === o.value}
          onClick={() => choose(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
