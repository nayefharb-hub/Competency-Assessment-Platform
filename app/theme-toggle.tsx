import { setThemeAction } from "./theme-actions";
import type { Theme } from "./theme";

const OPTIONS: { value: Theme; label: string; title: string }[] = [
  { value: "light", label: "Light", title: "Always use the light theme" },
  { value: "dark", label: "Dark", title: "Always use the dark theme" },
  { value: "system", label: "Auto", title: "Match this device's setting" },
];

/**
 * Light / Dark / Auto (N12). A form of submit buttons, not a client component:
 * three server actions are cheaper than shipping React state to the browser,
 * and keeping the app server-only is what lets the session cookie stay
 * httpOnly. It costs a round trip per switch, which for a preference somebody
 * sets once is the right trade.
 */
export default function ThemeToggle({ current }: { current: Theme }) {
  return (
    <form action={setThemeAction} className="themetoggle" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="submit"
          name="theme"
          value={o.value}
          title={o.title}
          aria-pressed={current === o.value}
        >
          {o.label}
        </button>
      ))}
    </form>
  );
}
