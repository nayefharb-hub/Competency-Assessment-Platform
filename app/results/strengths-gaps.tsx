import { controlBreakdown, fmtLevel, rollupAll } from "@/lib/rollup";
import { gapSummary, gapsOf, strengthSummary, strengthsOf } from "@/lib/narrative";
import { HealthPill, clip, indicatorLookup, pct } from "./capability-report";
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
 * It derives NO new arithmetic. `rollupAll` and `controlBreakdown` are the same
 * functions the by-area report calls; `gapsOf`/`strengthsOf`/`gapSummary`/
 * `strengthSummary` are ordering and text over their output. So the two views can
 * never disagree about a number — the same rollup logic, read two ways. (Each
 * view calls `rollupAll` itself rather than sharing one result object; that is a
 * few extra pure-CPU passes over already-fetched data, NOT extra Supabase round
 * trips — the round-trip budget is unmoved. Hoisting the call to the page is a
 * possible tidy-up, not a correctness fix, since the passes are deterministic and
 * agree by construction.) Fully server-rendered (native <details>), no client JS.
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

/**
 * One control inside a competency block: indicator + bar-on-bar + level/target.
 * The state DOT appears only when the control is below its own target
 * (exceptions-only, the drill-down's rule); ⚑ marks an escalating control.
 *
 * The BAR, however, is coloured by the control's health here — unlike the by-area
 * drill-down (`.ctrlrow`), which neutralises on/above-target bars. That is
 * deliberate and NOT the same context: each column is pre-filtered to one kind
 * (gaps show only below-target controls, strengths only at/or-above), so every
 * bar in a block is the same story and colour reinforces it. Exceptions-only
 * exists for the drill-down's MIXED list, where on-target rows must recede; the
 * omission does that job here. Owner endorsed the coloured bars in the Option-3
 * prototypes (DESIGN.md 2026-08-13).
 */
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
        <div className="ceblock-name">
          {r.ce_name}
          {/* The domain (L1) this competency (L2) sits in — its NAME, straight
              from the rollup (framework data), in a single neutral chip that is
              identical for every domain. Deliberately NOT colour-coded: a
              status-safe categorical domain palette does not exist alongside the
              health colours (validated, DESIGN.md 2026-08-13), so identity is
              carried by text. Works for any framework's domains, any number. */}
          <span className="pill pill-neutral domtag">{r.area}</span>
        </div>
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
 *  is agnostic to which side it shows. When empty, the `summary` already states
 *  the empty case ("No competency is below target."), so there is no separate
 *  empty note — a second copy of that sentence is exactly the duplicate a review
 *  pass caught. */
function BlockColumn({
  heading, summary, blocks,
}: {
  heading: string;
  summary: string;
  blocks: React.ReactNode[];
}) {
  const shown = blocks.slice(0, VISIBLE);
  const rest = blocks.slice(VISIBLE);
  return (
    <section className="sgcol">
      <div className="cap">{heading}</div>
      <p className="sgsummary">{summary}</p>
      {shown}
      {rest.length > 0 && (
        <details className="ce-more">
          <summary>Show {rest.length} more competenc{rest.length === 1 ? "y" : "ies"}</summary>
          <div className="ce-more-body">{rest}</div>
        </details>
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

  const indicatorOf = indicatorLookup(fw);

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
    // Scored controls only, strongest first — the "here is what is clear" detail
    // the by-competency form is for. Filtering out unscored active controls keeps
    // the rendered rows and strengthSummary's "M of N" over the SAME population,
    // so the count can never disagree with what is listed below it (a review
    // pass caught the mismatch when an active control was left unscored). No
    // escalation on a strength.
    const controls = strongestFirst(
      controlBreakdown(fw.data, assessment, r.ce_code).filter((c) => c.level !== null),
    );
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
      />
      <BlockColumn
        heading="DEVELOPMENT AREAS · most serious first"
        summary={gapsHeadline}
        blocks={gaps.map(gapBlock)}
      />
    </div>
  );
}
