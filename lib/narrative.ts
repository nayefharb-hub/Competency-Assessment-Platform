/**
 * Narrative lines and development-plan text for the results screen.
 *
 * Every sentence here is ASSEMBLED FROM THE ROLLUP NUMBERS — no prose is invented,
 * no model is called, nothing reaches the network. A narrative line is a view of
 * `CeResult` / `AreaResult`, deterministic and unit-tested (scripts/narrative.test.mjs),
 * so it changes only when the scores do and it can never state a verdict the
 * numbers beside it do not support. This is presentation, not arithmetic: it reads
 * `health` and the means, it never recomputes them.
 *
 * The tool supports a decision and never gates one (rollup-spec §7), so the
 * development actions are phrased as suggestions ("Consider …"), never mandates.
 */
import type { AreaResult, CeResult } from "./types";

/**
 * CE means to one decimal, "—" for null — the same rule as `fmtLevel` in
 * lib/rollup.ts. Kept as a local one-liner rather than a runtime import so this
 * presentation module stays dependency-free (only type imports, which erase),
 * which is also what lets the node test loader load it. It formats, it never
 * computes — the arithmetic single-source is rollup.ts, untouched.
 */
const fmtLevel = (n: number | null): string => (n === null ? "—" : n.toFixed(1));

/** control levels are integers; CE means are shown to one decimal (fmtLevel). */
const lvl = (n: number) => String(n);

/** Gap competencies (minor / deficit), most serious first: deficits before minors, then by gap. */
export function gapsOf(ces: CeResult[]): CeResult[] {
  const sev = (r: CeResult) => (r.health === "deficit" ? 2 : r.health === "minor" ? 1 : 0);
  return ces
    .filter((r) => r.health === "minor" || r.health === "deficit")
    .sort((a, b) => sev(b) - sev(a) || (b.gap ?? 0) - (a.gap ?? 0));
}

/**
 * One interpretive sentence per area (People / Practice / Perspective).
 * `ces` are that area's competence-element results.
 */
export function areaNarrative(area: AreaResult, ces: CeResult[]): string {
  if (area.actual === null || area.target === null) {
    return `${area.area}: not yet scored.`;
  }
  const nums = `${fmtLevel(area.actual)} vs ${fmtLevel(area.target)} target`;
  const gaps = gapsOf(ces);
  const above = ces.filter((r) => r.health === "above").length;

  if (gaps.length === 0) {
    const extra =
      above > 0
        ? `, ${above} of them a full level or more clear`
        : "";
    return `${area.area}: at or above target across all ${ces.length} competencies${extra} (${nums}).`;
  }

  const lead =
    area.actual >= area.target
      ? "strong overall"
      : area.target - area.actual <= 0.5
        ? "close to target overall"
        : "below target overall";
  const w = gaps[0];
  // A deficit can be driven by one severe control while the CE MEAN sits at or
  // above target (escalation_drove_health). Describing it as "<mean> against
  // <target>" would print e.g. "3.4 against 3.0" — a mean above target labelled
  // as the gap, the number contradicting the verdict. Name the escalating
  // control instead, the way ceNarrative does.
  const wdesc =
    w.escalation_drove_health && w.escalated_by.length > 0
      ? `${w.ce_name} (${w.ce_code}), held in deficit by control ${w.escalated_by[0].control_code} at ${lvl(w.escalated_by[0].level)} against ${lvl(w.escalated_by[0].target)}`
      : `${w.ce_name} (${w.ce_code}), ${fmtLevel(w.actual)} against ${fmtLevel(w.target)}`;
  const others = gaps.length - 1;
  const more = others > 0 ? `, and ${others} other${others === 1 ? "" : "s"}` : "";
  return `${area.area}: ${lead} (${nums}); the main gap is ${wdesc}${more}.`;
}

/**
 * One sentence naming what drives a gap competency (minor / deficit). Used in the
 * development-plan table's focus column. Names the escalating control when
 * escalation alone set the verdict, otherwise the weakest control.
 */
export function ceNarrative(r: CeResult): string {
  if (r.escalation_drove_health && r.escalated_by.length > 0) {
    const [first, ...rest] = r.escalated_by;
    const more = rest.length > 0 ? ` (and ${rest.length} more ${rest.length === 1 ? "control" : "controls"} 2+ levels below)` : "";
    return `The mean is on target, but ${first.control_code} scored ${lvl(first.level)} against a target of ${lvl(first.target)}${more}.`;
  }
  if (r.weakest) {
    return `Weakest control ${r.weakest.control_code} at ${lvl(r.weakest.level)}, against an element target of ${fmtLevel(r.target)}.`;
  }
  return `Below the element target of ${fmtLevel(r.target)}.`;
}

/**
 * A suggested development action for a gap competency. A SUGGESTION — the tool
 * supports a decision and never gates one, so this never reads as a mandate.
 */
export function suggestedAction(r: CeResult): string {
  if (r.escalation_drove_health && r.escalated_by.length > 0) {
    const first = r.escalated_by[0];
    return `Consider prioritising ${first.control_code}: one control this far below target holds the whole element in deficit.`;
  }
  if (r.weakest) {
    return `Consider focused development on ${r.weakest.control_code} (currently ${lvl(r.weakest.level)}) to lift the element toward target.`;
  }
  return `Consider development across this element's active controls.`;
}
