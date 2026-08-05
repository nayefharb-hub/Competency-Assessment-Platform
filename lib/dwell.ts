/**
 * The clock behind `score.dwell_ms` (D28).
 *
 * Plain closures rather than a class or a hook so the awkward part — what
 * counts as time on a control — is unit-testable without a browser. The React
 * wiring lives in `app/assess/score-panel.tsx`.
 *
 * THREE RULES, all there because the measurement is used to ask whether an
 * assessment was taken seriously, and a measurement used for that has to be
 * defensible to the person it describes:
 *
 * 1. HIDDEN TIME DOES NOT COUNT. A PM who opens the control, goes to a
 *    meeting and comes back has not spent forty minutes thinking. The tab
 *    being backgrounded is the only signal available for that, and it catches
 *    the common case (switching tabs, locking the screen, closing the laptop).
 *
 * 2. AN IMPLAUSIBLE READING IS DISCARDED, NOT CLAMPED. Someone who leaves the
 *    tab open and visible for an hour produces a number the ceiling would turn
 *    into "10 minutes" — a value that then sits in a median looking exactly
 *    like a real reading. NULL says "not measured", which is true, and the
 *    analysis screen reports how many readings it has rather than assuming.
 *
 * 3. A CLOCK THAT WENT BACKWARDS IS BROKEN, NOT FAST. The caller feeds this
 *    `performance.now()`, which is monotonic — but a review pass found the
 *    first version clamping negative spans to zero with `Math.max(0, …)`,
 *    which made the "return null" branch dead code and turned an NTP step or a
 *    suspend/resume into a **0 ms reading**. Zero is below every control's
 *    reading floor, so a hardware event would have been reported as the most
 *    severe possible finding about a person. Now the clock latches broken and
 *    reads null for the rest of the control.
 *
 * Note what none of this does: there is no floor. A 900ms answer is recorded
 * as 900ms, because that reading is the entire point.
 */

/**
 * Above this, the reading is discarded as "walked away with the tab visible".
 *
 * Ten minutes. The longest control in ICB4 carries 463 words — about 2.3
 * minutes of reading, or ~5 with every measure read — so this leaves a wide
 * margin for a genuinely slow, careful answer before it stops believing the
 * clock. A STARTING NUMBER, not a studied one: if the pilot shows real answers
 * being discarded, raise it, and say so here.
 */
export const DWELL_CEILING_MS = 10 * 60_000;

export interface DwellClock {
  /** The tab went away — bank what has elapsed and stop counting. */
  pause(atMs: number): void;
  /** The tab came back — start counting again. */
  resume(atMs: number): void;
  /** Total visible milliseconds, or null when the reading is not believable. */
  read(atMs: number): number | null;
}

export function createDwellClock(startMs: number, visible = true): DwellClock {
  let accumulated = 0;
  let startedAt: number | null = visible ? startMs : null;
  // Latching, not per-call: once time has misbehaved, every later span on this
  // control is suspect too, and a clock that healed itself mid-control would
  // report a partial duration as if it were the whole one.
  let broken = false;

  const span = (from: number, to: number): number => {
    const d = to - from;
    if (!Number.isFinite(d) || d < 0) { broken = true; return 0; }
    return d;
  };

  return {
    pause(atMs) {
      if (startedAt === null) return;         // already paused; not an error
      accumulated += span(startedAt, atMs);
      startedAt = null;
    },
    resume(atMs) {
      if (startedAt !== null) return;         // already running
      startedAt = atMs;
    },
    read(atMs) {
      const live = startedAt === null ? 0 : span(startedAt, atMs);
      const total = accumulated + live;
      if (broken || !Number.isFinite(total)) return null;
      if (total > DWELL_CEILING_MS) return null;
      return Math.round(total);
    },
  };
}

/**
 * The same believability test, server side.
 *
 * The client is not trusted with this: the value arrives from a browser, and
 * a browser can send anything. `saveSelfScore` additionally clamps the claim
 * against the assessment's own `started_at`, which is the bound that keeps the
 * design's cost argument true (see docs/design-assessment-flow-and-pace.md,
 * D28a). Neither can detect a *plausible* lie, which is why pace is never read
 * alone — see lib/pace.ts.
 */
export function sanitiseDwell(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > DWELL_CEILING_MS) return null;
  return Math.round(raw);
}
