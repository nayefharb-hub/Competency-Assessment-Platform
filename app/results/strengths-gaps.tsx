import { controlBreakdown, fmtLevel, rollupAll } from "@/lib/rollup";
import { gapSummary, gapsOf, strengthSummary, strengthsOf, tidyIndicator } from "@/lib/narrative";
import { HealthPill, clip, pct } from "./capability-report";
import type { Assessment, CeResult, ControlScore, Framework, Level } from "@/lib/types";

/**
 * The strengths-and-gaps view of /results (?view=gaps) — an alternative reading
 * of the SAME approved assessment the by-area report shows, turned around the
 * question "which competency do I develop?" rather than "how do I score by
 * area?". Two symmetric columns: strengths on the left (most clear of target
 * first) and development areas on the right (most serious first). Each side is a
 * list of competency BLOCKS that open to their controls (owner picked the
 * symmetric detailed form, 2026-08-13): a gap block shows the controls that are
 * below target, weakest first, with a ⚑ on any that escalates; a strength block
 * shows its controls strongest first, celebrating what is clear.
 *
 * It computes NOTHING new. `rollupAll` and `controlBreakdown` are the same
 * functions the by-area report calls; `gapsOf`/`strengthsOf`/`gapSummary`/
 * `strengthSummary` are ordering and text over their output. So the two views can
 * never disagree about a number — there is one rollup, read two ways. Fully
 * server-rendered (native <details> for the overflow), no client JS.
 */

/**
 * Competency blocks shown in a column before the rest fold behind "Show N more".
 * Four keeps the most significant in view (each column is sorted worst/best
 * first) without the column running the full length of its data; the remainder
 * is one click away and the column's summary line states the totals regardless.
 */
const VISIBLE = 4;

const NO_ESCALATION: ReadonlySet<string> = new Set();

/**
 * A strength's controls, strongest first (largest margin above its own target),
 * unscored/untargeted last. The mirror of `controlBreakdown`'s weakest-first
 * order, computed here rather than in the engine because it is a presentation
 * order specific to this column, not a rollup fact.
 */
function strongestFirst(controls: ControlScore[]): ControlScore[] {
  const margin = (c: ControlScore) =>
    c.level === null || c.target === null ? -Infinity : c.level - c.target;
  return [...controls].sort((a, b) => margin(b) - margin(a) || a.code.localeCompare(b.code));
}

/** One control inside a competency block: indicator + bar-on-bar + level/target.
 *  The state dot appears only when the control is below its own target
 *  (exceptions-only, the drill-down's rule); ⚑ marks an escalating control. */
function ControlRow({
  cs, indicator, escalated, labelOf,
}: {
  cs: ControlScore;
  indicator: string;
  escalated: boolean;
  labelOf: (n: Level | null) => string;
}) {
  return (
    <div className="cerow" title={indicator}>
      <div className="cerow-name">
        {escalated && (
          <span className="escflag" title="2+ levels below target — escalated" aria-label="escalated">
            ⚑
          </span>
        )}
        {clip(indicator, 88)}
      </div>
      <div className="track track-sm">
        {cs.target !== null && <div className="target" style={{ left: pct(cs.target) }} />}
        {cs.level !== null && cs.health && (
          <div className={`actual ${cs.health}`} style={{ width: pct(cs.level) }} />
        )}
      </div>
      <div className="cerow-val">
        {cs.below && cs.health && <span className={`dot-h ${cs.health}`} aria-hidden="true" />}
        <b className="tnum">{labelOf(cs.level)}</b>{" "}
        <span className="muted tnum">/ {labelOf(cs.target)}</span>
      </div>
    </div>
  );
}

/**
 * One competency block — header (name · health pill · mean/target), a one-line
 * summary, and its controls. Used by both columns; the left-border colour comes
 * from the competency's own health (`is-${health}`), so a strength reads green /
 * indigo and a gap reads amber / red without a second code path.
 */
function CompetencyBlock({
  r, controls, summary, escalated, indicatorOf, labelOf,
}: {
  r: CeResult;
  controls: ControlScore[];
  summary: string;
  escalated: ReadonlySet<string>;
  indicatorOf: (code: string) => string;
  labelOf: (n: Level | null) => string;
}) {
  return (
    <div className={`ceblock is-${r.health}`}>
      <div className="ceblock-head">
        <div className="ceblock-name">{r.ce_name}</div>
        <div className="ceblock-meta">
          <HealthPill health={r.health} />
          <span className="ceblock-val tnum">
            <b>{fmtLevel(r.actual)}</b> <span className="muted">/ {fmtLevel(r.target)}</span>
          </span>
        </div>
      </div>
      <div className="ceblock-sum">{summary}</div>
      <div className="ceblock-rows">
        {controls.map((cs) => (
          <ControlRow
            key={cs.code}
            cs={cs}
            indicator={indicatorOf(cs.code)}
            escalated={escalated.has(cs.code)}
            labelOf={labelOf}
          />
        ))}
      </div>
    </div>
  );
}

/** A column: heading, a summary line, the first VISIBLE blocks, then the rest
 *  behind a native <details> disclosure. `blocks` are pre-rendered so the column
 *  is agnostic to which side it shows. */
function BlockColumn({
  heading, summary, blocks, empty,
}: {
  heading: string;
  summary: string;
  blocks: React.ReactNode[];
  empty: string;
}) {
  const shown = blocks.slice(0, VISIBLE);
  const rest = blocks.slice(VISIBLE);
  return (
    <section className="sgcol">
      <div className="cap">{heading}</div>
      <p className="sgsummary">{summary}</p>
      {blocks.length === 0 ? (
        <p className="note">{empty}</p>
      ) : (
        <>
          {shown}
          {rest.length > 0 && (
            <details className="ce-more">
              <summary>Show {rest.length} more competenc{rest.length === 1 ? "y" : "ies"}</summary>
              <div className="ce-more-body">{rest}</div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

export function StrengthsGaps({
  fw,
  assessment,
}: {
  fw: { data: Framework; labelOf: (n: Level | null) => string };
  assessment: Assessment;
}) {
  const results = rollupAll(fw.data, assessment);
  const gaps = gapsOf(results);
  const strengths = strengthsOf(results);

  const ctrlText = new Map(fw.data.controls.map((c) => [c.code, c.indicator ?? c.code]));
  const indicatorOf = (code: string) => tidyIndicator(ctrlText.get(code) ?? code);

  const gapBlock = (r: CeResult) => {
    const controls = controlBreakdown(fw.data, assessment, r.ce_code);
    const escalated = new Set(r.escalated_by.map((e) => e.control_code));
    // Gaps show only the controls actually below target — the on-target ones are
    // not the development story here (they already are, weakest first).
    return (
      <CompetencyBlock
        key={r.ce_code}
        r={r}
        controls={controls.filter((c) => c.below)}
        summary={gapSummary(r, controls)}
        escalated={escalated}
        indicatorOf={indicatorOf}
        labelOf={fw.labelOf}
      />
    );
  };

  const strengthBlock = (r: CeResult) => {
    const controls = strongestFirst(controlBreakdown(fw.data, assessment, r.ce_code));
    // Strengths show every control, strongest first — the "here is what is clear"
    // detail the by-competency form is for. No escalation on a strength.
    return (
      <CompetencyBlock
        key={r.ce_code}
        r={r}
        controls={controls}
        summary={strengthSummary(controls)}
        escalated={NO_ESCALATION}
        indicatorOf={indicatorOf}
        labelOf={fw.labelOf}
      />
    );
  };

  const deficits = gaps.filter((r) => r.health === "deficit").length;
  const minors = gaps.length - deficits;
  const above = strengths.filter((r) => r.health === "above").length;
  const ready = strengths.length - above;

  // "No competency is below/above target" — NOT "every competency is …": an
  // unscored competency (health null) is in neither column, so the stronger claim
  // would be false while one sits unscored. Each column counts only its own side.
  const gapsHeadline =
    gaps.length === 0
      ? "No competency is below target."
      : `${gaps.length} development area${gaps.length === 1 ? "" : "s"} — ` +
        [
          deficits > 0 ? `${deficits} capability deficit${deficits === 1 ? "" : "s"}` : null,
          minors > 0 ? `${minors} minor gap${minors === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const strengthsHeadline =
    strengths.length === 0
      ? "No competency is at or above target yet."
      : `${strengths.length} strength${strengths.length === 1 ? "" : "s"} — ` +
        [
          above > 0 ? `${above} above target` : null,
          ready > 0 ? `${ready} role ready` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="sgcols">
      <BlockColumn
        heading="STRENGTHS · most clear of target first"
        summary={strengthsHeadline}
        blocks={strengths.map(strengthBlock)}
        empty="No competency is at or above target yet."
      />
      <BlockColumn
        heading="DEVELOPMENT AREAS · most serious first"
        summary={gapsHeadline}
        blocks={gaps.map(gapBlock)}
        empty="No competency is below target."
      />
    </div>
  );
}
