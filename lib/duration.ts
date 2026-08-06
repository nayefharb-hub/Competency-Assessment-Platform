import type { Control, Measure } from "./types.ts";

/**
 * How long a piece of the assessment takes — derived from its own text.
 *
 * WHY THIS IS NOT A CONSTANT. "About 90 seconds per control" would be a number
 * somebody invented, and the controls are not interchangeable: the shortest
 * carries 68 words, the longest 463. Reading load is the thing that varies, so
 * reading load is what this measures.
 *
 * WHAT IT IS FOR (docs/design-assessment-flow-and-pace.md, D15b). This is a
 * property of the WORK, not a prediction about the person — a cook time on a
 * recipe. "About 5 minutes" cannot be falsified by a PM who takes eight; it
 * answers "can I start this now?", which is the question that gets a sitting
 * started, rather than "when will I be done?", which nobody can answer.
 *
 * THE TWO NUMBERS BELOW ARE ASSUMPTIONS AND CARRY THE WHOLE RESULT.
 * Measured across the framework as it stands: 134-160 minutes for all 132
 * controls at these rates. At 250 wpm / 10s it is 1h55m; at 150 wpm / 30s it
 * is 3h40m. The word counts are facts; these are not. They are here, named,
 * so that the next reader can see what is derived and what is assumed — and
 * so they can be replaced by observation once the pilot supplies it (D19).
 */

/** Words per minute for careful reading of professional prose. ASSUMPTION. */
const RATE = 200;

/** Seconds to weigh six levels and pick one, per control. ASSUMPTION. */
const DECIDE = 20;

function words(text: string | null | undefined): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Words of measure text per control code.
 *
 * Built ONCE and passed in, because the naive version rebuilt it inside every
 * call: 28 competence elements + 3 areas = 31 calls, each re-splitting all 586
 * measures, ~18,200 regex splits per render and 30/31 of the work discarded.
 * Measured at ~13ms per render on the control page — the hottest path in the
 * app, and the one two PRs were spent making fast. No round trip was added,
 * which is exactly why it would have gone unnoticed.
 */
export function measureIndex(measures: Measure[]): Map<string, number> {
  const byControl = new Map<string, number>();
  for (const m of measures) {
    byControl.set(m.control_code, (byControl.get(m.control_code) ?? 0) + words(m.text));
  }
  return byControl;
}

/**
 * Seconds to read one control's own text once, at RATE.
 *
 * Deliberately EXCLUDES the judgement allowance that `estimateMinutes` adds.
 * This is used as the "could not have read it" line in pace analysis, and that
 * line has to be the strongest claim available: below it, the words on the
 * screen did not pass through anybody's eyes at a rate a person reads at.
 * Folding in DECIDE would turn a fact about reading speed into a judgement
 * about how long thinking takes — an assumption doing work it cannot support
 * when the output is "this person may have clicked through their assessment".
 */
export function readingSeconds(indicator: string | null | undefined,
  description: string | null | undefined): number {
  return ((words(indicator) + words(description)) / RATE) * 60;
}

export interface Estimate {
  /** Skimming the measures, which are marked "reference only, not scored". */
  low: number;
  /** Reading everything on the page. */
  high: number;
}

/**
 * Minutes for a set of controls, as a range.
 *
 * The range is the honest part: `low` assumes the measures are skimmed (they
 * are labelled reference-only on screen, and most readers will), `high`
 * assumes every word is read. A single number would hide that choice.
 */
export function estimateMinutes(controls: Control[], byControl: Map<string, number>): Estimate {
  let core = 0;
  let reference = 0;
  for (const c of controls) {
    core += words(c.indicator) + words(c.description);
    reference += byControl.get(c.code) ?? 0;
  }

  const deciding = (controls.length * DECIDE) / 60;
  return {
    low: Math.round(core / RATE + deciding),
    high: Math.round((core + reference) / RATE + deciding),
  };
}

/**
 * The estimate as the screen says it.
 *
 * Collapses to one number when the range is tight — "about 5 minutes" reads as
 * an estimate, while "5-5 minutes" reads as a machine that forgot to round.
 */
export function estimateLabel(e: Estimate): string {
  if (e.low <= 0 && e.high <= 0) return "a moment";
  if (e.low === e.high) return `about ${e.high} min`;
  return `about ${e.low}–${e.high} min`;
}
