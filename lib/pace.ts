import type { Control, Level } from "./types.ts";
import { readingSeconds } from "./duration.ts";

/**
 * Pace analysis — how an assessment was actually filled in.
 *
 * WHAT THIS IS FOR (docs/design-assessment-flow-and-pace.md, D22/D28). A PM
 * who clicks through 132 controls in ten minutes to get the task off their
 * list produces 132 numbers that look exactly like an assessment and are
 * worth nothing. The assessor then rolls them up, compares them to targets and
 * makes training decisions on them. Rushing does not just cost the rusher; it
 * poisons the dataset the whole tool exists to produce.
 *
 * WHY PACE ALONE IS NOT THE ANSWER, and this module returns five numbers
 * rather than one. Pace is gameable in the slow direction — a PM told their
 * time is recorded can sit on each control doing nothing. That costs them the
 * whole two hours they were trying to avoid, and it does not make the answers
 * better: someone who stalls without thinking still produces a flat sheet.
 * So the two content signals below are the ones that cannot be faked by
 * waiting, and they are what turn a flag into a finding:
 *
 *   fast                     → a flag. Some PMs genuinely are fast.
 *   fast + flat + no evidence → a finding. Nobody arrives there by being good.
 *
 * NOTHING HERE PRODUCES A VERDICT. There is no threshold, no colour, no score
 * and no pass/fail — consistent with the standing rule that the tool supports
 * a decision and never gates one. It reports what happened and leaves the
 * reading to the person who knows the PM.
 *
 * Everything is derived in memory from rows the caller already fetched.
 */

export interface PaceScore {
  control_code: string;
  self_level: Level | null;
  evidence: string | null;
  /** Milliseconds on screen before Next. NULL where it was not measured. */
  dwell_ms: number | null;
  /**
   * When the measured answer was given — stamped beside `dwell_ms` and only
   * with it, so it orders the readings themselves.
   *
   * NOT `updated_at`, which cannot do this job: a trigger rewrites it on every
   * UPDATE, and Submit upserts all 132 rows to prefill the assessor's sheet.
   * A review pass found the first version sorting on it, which meant the trend
   * became an arbitrary heap order the moment a PM submitted — and could
   * report someone who sped up as having slowed down, in precisely the state
   * an assessor reads.
   */
  answered_at: string | null;
}

export interface PaceSummary {
  /** Controls with a self_level — the denominator for the content signals. */
  scored: number;
  /** Controls that also carry a dwell reading. Reported, never assumed. */
  measured: number;
  /** Median seconds per control across the measured ones. */
  medianSeconds: number | null;
  /** Median of the first half of the readings, in the order answered. */
  firstHalfSeconds: number | null;
  /** …and the second half. Familiarity should show up as a fall. */
  secondHalfSeconds: number | null;
  /**
   * Measured answers given faster than the control's own text can be read at
   * 200 wpm. Not "quick" — below the floor at which the words were seen.
   */
  underReading: number;
  /** Distinct levels the PM used. 1 across a whole assessment is a straight line. */
  levelsUsed: number;
  /** Share of scored controls sitting on the single most-used level, 0–1. */
  modalShare: number;
  /** Share of scored controls with evidence text, 0–1. */
  evidenceShare: number;
}

/** Per-competency breakdown, so a slow or fast patch is locatable. */
export interface PaceByCe {
  ce_code: string;
  scored: number;
  measured: number;
  medianSeconds: number | null;
}

/**
 * Halves need enough readings to mean anything. Below this the trend is
 * reported as unknown rather than as the difference between two samples of
 * three — which would read as a finding and be noise.
 */
const MIN_FOR_TREND = 8;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

/** Readings in the order they were answered, as seconds. */
function orderedSeconds(scores: PaceScore[]): number[] {
  return scores
    .filter((s) => s.dwell_ms !== null && Number.isFinite(s.dwell_ms))
    // Plain comparison, not localeCompare: ICU root collation sorts "." before
    // "+", so "…T10:00:00+00:00" sorts AFTER "…T10:00:00.5+00:00" — backwards.
    // Postgres omits the fractional part when it is zero, so mixed-precision
    // strings out of this one column are routine rather than theoretical.
    // A missing answered_at sorts first; those rows predate the column and
    // carry no dwell, so they are already filtered out above.
    .sort((a, b) => {
      const x = a.answered_at ?? "", y = b.answered_at ?? "";
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((s) => (s.dwell_ms as number) / 1000);
}

export function summarise(scores: PaceScore[], controls: Control[]): PaceSummary {
  const byCode = new Map(controls.map((c) => [c.code, c]));
  // ONE POPULATION FOR ALL SIX FIGURES. `controls` is the ACTIVE set, and
  // "inactive controls contribute nothing to any rollup" (CLAUDE.md). The
  // first version filtered only where it happened to need a lookup, so
  // `underReading` and the per-competency table excluded the inactive control
  // while `measured` and `scored` counted it — which can show `measured`
  // exceeding `scored`, i.e. a visibly broken denominator on the one screen
  // whose whole job is to be trusted about denominators.
  scores = scores.filter((s) => byCode.has(s.control_code));
  const scored = scores.filter((s) => s.self_level !== null);
  const seconds = orderedSeconds(scores);

  // The trend is over the readings, not over the calendar: a PM who does the
  // assessment in four sittings should still see whether they got faster.
  const half = Math.floor(seconds.length / 2);
  const trendable = seconds.length >= MIN_FOR_TREND;

  const levelCounts = new Map<number, number>();
  for (const s of scored) {
    levelCounts.set(s.self_level as number, (levelCounts.get(s.self_level as number) ?? 0) + 1);
  }
  const modal = Math.max(0, ...levelCounts.values());

  let underReading = 0;
  for (const s of scores) {
    if (s.dwell_ms === null || s.self_level === null) continue;
    const control = byCode.get(s.control_code);
    if (!control) continue;
    if (s.dwell_ms / 1000 < readingSeconds(control.indicator, control.description)) {
      underReading += 1;
    }
  }

  return {
    scored: scored.length,
    measured: seconds.length,
    medianSeconds: round1(median(seconds)),
    firstHalfSeconds: trendable ? round1(median(seconds.slice(0, half))) : null,
    secondHalfSeconds: trendable ? round1(median(seconds.slice(half))) : null,
    underReading,
    levelsUsed: levelCounts.size,
    modalShare: scored.length === 0 ? 0 : modal / scored.length,
    evidenceShare: scored.length === 0
      ? 0
      : scored.filter((s) => (s.evidence ?? "").trim().length > 0).length / scored.length,
  };
}

/**
 * The same median, per competence element, in framework order.
 *
 * `ceOrder` comes from the framework's own sort order rather than from the
 * order rows happen to arrive in — the two agree today and stop agreeing the
 * moment a control's sort_order is edited.
 */
export function summariseByCe(
  scores: PaceScore[],
  controls: Control[],
  ceOrder: string[],
): PaceByCe[] {
  const ceOfControl = new Map(controls.map((c) => [c.code, c.ce_code]));
  const buckets = new Map<string, PaceScore[]>();
  for (const s of scores) {
    const ce = ceOfControl.get(s.control_code);
    if (!ce) continue;
    const list = buckets.get(ce);
    if (list) list.push(s);
    else buckets.set(ce, [s]);
  }

  const rows: PaceByCe[] = [];
  for (const ce of ceOrder) {
    const list = buckets.get(ce);
    if (!list) continue;
    const seconds = orderedSeconds(list);
    rows.push({
      ce_code: ce,
      scored: list.filter((s) => s.self_level !== null).length,
      measured: seconds.length,
      medianSeconds: round1(median(seconds)),
    });
  }
  return rows;
}

/** "1 min 20 s" / "45 s" — a duration a person reads, not 80.4. */
export function paceLabel(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const mins = Math.floor(seconds / 60);
  const rest = Math.round(seconds - mins * 60);
  return rest === 0 ? `${mins} min` : `${mins} min ${rest} s`;
}
