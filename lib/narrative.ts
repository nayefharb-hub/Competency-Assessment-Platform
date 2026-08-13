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
import type { AreaResult, CeResult, ControlScore } from "./types";

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

/**
 * Strip trailing extraction boilerplate from an ICB4 indicator. The T0 PDF
 * extractor merged page footers, copyright lines, URLs and version strings into
 * a handful of indicator cells (5 of 133: 4.3.3.2, 4.4.4.5, 4.5.1.3, 4.5.8.5,
 * 4.5.13.4 — the last is 394 chars of "…Version 4.0 www.ipma.world ® MOVING
 * FORWARD…"). That junk was invisible while the results screen showed control
 * CODES; it surfaces the moment we show indicator TEXT. This is a PRESENTATION
 * guard, not a data edit — the stored ICB4 text is untouched and the admin
 * read-only source block still shows it verbatim. The durable fix is in the
 * extractor (the item-6 workstream); until then this keeps /results clean.
 * Unit-tested in scripts/narrative.test.mjs.
 */
export function tidyIndicator(s: string): string {
  return s
    .replace(/\s*©\s*\d{4}\s+International Project Management Association.*$/is, "")
    .replace(/\s*Version\s+4\.0.*$/is, "")
    .replace(/\s*www\.ipma\.world.*$/is, "")
    .replace(/\s+\d{2,3}\s*$/, "")
    .trim();
}

/**
 * Gap competencies (minor / deficit), most serious first: deficits before minors,
 * then by gap, then by ce_code. The final ce_code tiebreak makes the order TOTAL
 * rather than leaning on the sort being stable — two equal-severity, equal-gap
 * competencies otherwise order only by input position, which is the kind of
 * silent dependency a reordered `rollupAll` would surface. `strengthsOf` mirrors
 * this exactly.
 */
export function gapsOf(ces: CeResult[]): CeResult[] {
  const sev = (r: CeResult) => (r.health === "deficit" ? 2 : r.health === "minor" ? 1 : 0);
  return ces
    .filter((r) => r.health === "minor" || r.health === "deficit")
    .sort((a, b) => sev(b) - sev(a) || (b.gap ?? 0) - (a.gap ?? 0) || a.ce_code.localeCompare(b.ce_code));
}

/**
 * Strength competencies (above / role-ready), furthest clear of target first —
 * the mirror of gapsOf for the strengths column of the strengths-and-gaps view.
 * Distance is the NEGATIVE gap (target - actual < 0 means clear of target), so
 * sorting gap ascending puts the most-clear first. Ties resolve by ce_code so
 * the order is total, the same final tiebreak gapsOf carries.
 */
export function strengthsOf(ces: CeResult[]): CeResult[] {
  return ces
    .filter((r) => r.health === "above" || r.health === "ready")
    .sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0) || a.ce_code.localeCompare(b.ce_code));
}

/**
 * The one-line summary under a gap competency's name. Assembled from the control
 * breakdown (rollup arithmetic), never invented — the same discipline as every
 * other line in this module.
 *
 * USUAL CASE — one or more controls below their own target: how many, and how far
 * down the worst is. "levels down" is an integer gap between two integer control
 * levels, so it is exact, not a mean.
 *
 * EDGE CASE — the element is a gap yet NO single control is below its own target.
 * The earlier version of this comment claimed that could not happen; it can. The
 * element mean and the target mean are taken over different control sets — the
 * mean over SCORED active controls, the target over active controls that HAVE a
 * target (rollup.ts) — so an active control with no target, or one activated
 * after approval (unscored, but its live target counted), can drag the mean below
 * target while every scored control sits at or above its own. Rather than print
 * "0 controls below target" over an empty list, describe the element mean. Today
 * no active control is untargeted, so this path is not reachable through the app,
 * but it is one admin edit away and cheap to state honestly.
 */
export function gapSummary(
  r: { actual: number | null; target: number | null },
  controls: ControlScore[],
): string {
  const below = controls.filter((c) => c.below);
  if (below.length === 0) {
    return `element mean ${fmtLevel(r.actual)} below the ${fmtLevel(r.target)} target`;
  }
  let worst = 0;
  for (const c of below) {
    if (c.level !== null && c.target !== null) worst = Math.max(worst, c.target - c.level);
  }
  const n = below.length;
  const parts = [`${n} control${n === 1 ? "" : "s"} below target`];
  if (worst > 0) parts.push(`weakest ${worst} level${worst === 1 ? "" : "s"} down`);
  return parts.join(" · ");
}

/**
 * The one-line summary under a STRENGTH competency's name — the mirror of
 * gapSummary. How many of its controls sit at or above their own target, and how
 * far up the strongest is. A strength is judged on its MEAN, so it can still hold
 * a control or two below target (as long as none is 2+ levels down, which would
 * escalate it out of the strengths column), so the "M of N" wording stays honest
 * when that happens rather than claiming all are clear. "levels up" is an integer
 * difference of integer levels, exact, not a mean.
 */
export function strengthSummary(controls: ControlScore[]): string {
  const scored = controls.filter((c) => c.level !== null && c.target !== null);
  const total = scored.length;
  const meet = scored.filter((c) => (c.level as number) >= (c.target as number)).length;
  let best = 0;
  for (const c of scored) {
    const up = (c.level as number) - (c.target as number);
    if (up > best) best = up;
  }
  const lead =
    total === 0
      ? "no scored controls"
      : meet === total
        ? `all ${total} control${total === 1 ? "" : "s"} at or above target`
        : `${meet} of ${total} at or above target`;
  const parts = [lead];
  if (best > 0) parts.push(`strongest ${best} level${best === 1 ? "" : "s"} up`);
  return parts.join(" · ");
}

/**
 * One interpretive sentence per area (People / Practice / Perspective).
 * `ces` are that area's competence-element results.
 */
export function areaNarrative(
  area: AreaResult,
  ces: CeResult[],
  /**
   * Resolve a control code to human text (its ICB4 indicator). Injected rather
   * than imported so this module stays dependency-free and node-testable; the
   * default is the identity, which is what the unit tests assert against.
   */
  controlLabel: (code: string) => string = (c) => c,
): string {
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
  // control (by its indicator text) instead.
  const wdesc =
    w.escalation_drove_health && w.escalated_by.length > 0
      ? `${w.ce_name}, held in deficit by “${controlLabel(w.escalated_by[0].control_code)}” at ${lvl(w.escalated_by[0].level)} against ${lvl(w.escalated_by[0].target)}`
      : `${w.ce_name}, ${fmtLevel(w.actual)} against ${fmtLevel(w.target)}`;
  const others = gaps.length - 1;
  const more = others > 0 ? `, and ${others} other${others === 1 ? "" : "s"}` : "";
  return `${area.area}: ${lead} (${nums}); the main gap is ${wdesc}${more}.`;
}
