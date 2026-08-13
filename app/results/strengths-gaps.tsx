import { controlBreakdown, fmtLevel, rollupAll } from "@/lib/rollup";
import { gapControlSummary, gapsOf, strengthsOf, tidyIndicator } from "@/lib/narrative";
import { HealthPill, clip } from "./capability-report";
import type { Assessment, CeResult, ControlScore, Framework, Level } from "@/lib/types";

/**
 * The strengths-and-gaps view of /results (?view=gaps) — an alternative reading
 * of the SAME approved assessment the by-area report shows, turned around the
 * question "which competency do I develop?" rather than "how do I score by
 * area?". Two columns: strengths on the left (summarised, most clear of target
 * first) and development areas on the right (grouped by competency, most serious
 * first, each opened to the controls that are actually short).
 *
 * It computes NOTHING new. `rollupAll` and `controlBreakdown` are the same
 * functions the by-area report calls; `gapsOf`/`strengthsOf`/`gapControlSummary`
 * are ordering and text over their output. So the two views can never disagree
 * about a number — there is one rollup, read two ways. Fully server-rendered
 * (native <details> for the overflow), no client JS, consistent with the rest of
 * /results.
 */

const MAX = 5;
const pct = (v: number) => `${(v / MAX) * 100}%`;

/**
 * Gap competencies shown before the rest fold behind "Show N more". Four keeps
 * the most serious in view (deficits always sort first) without the column
 * running the length of the strengths beside it; the remainder is one click away
 * and its tier breakdown is stated in the column's summary line regardless.
 */
const VISIBLE_GAPS = 4;

/** A strength: name, actual/target, and how far clear of target it sits. */
function StrengthRow({ r }: { r: CeResult }) {
  const clear = r.gap === null ? 0 : -r.gap;
  const tier = r.health === "above" ? "above" : "ready";
  return (
    <div className="strength">
      <span className="sname">{r.ce_name}</span>
      <span className="sval tnum">
        <b>{fmtLevel(r.actual)}</b> <span className="muted">/ {fmtLevel(r.target)}</span>
        {clear > 0 && <span className={`smargin ${tier}`}> +{clear.toFixed(1)}</span>}
      </span>
    </div>
  );
}

/** One below-target control inside a gap block: bar-on-bar + a level/target label. */
function GapControlRow({
  cs, indicator, escalated, labelOf,
}: {
  cs: ControlScore;
  indicator: string;
  escalated: boolean;
  labelOf: (n: Level | null) => string;
}) {
  return (
    <div className={`gapctrl${escalated ? " is-esc" : ""}`} title={indicator}>
      <div className="gcname">
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
      <div className="gcval">
        {cs.health && <span className={`dot-h ${cs.health}`} aria-hidden="true" />}
        <b className="tnum">{labelOf(cs.level)}</b>{" "}
        <span className="muted tnum">/ {labelOf(cs.target)}</span>
      </div>
    </div>
  );
}

/**
 * One gap competency: the header (name · pill · mean/target), a one-line summary,
 * and every control that is below its own target, weakest first. `controls` is
 * the full active breakdown (already worst-shortfall first); we render only the
 * ones below target — the on-target controls are not the development story here.
 */
function GapBlock({
  r, controls, indicatorOf, labelOf,
}: {
  r: CeResult;
  controls: ControlScore[];
  indicatorOf: (code: string) => string;
  labelOf: (n: Level | null) => string;
}) {
  const below = controls.filter((c) => c.below);
  const escalated = new Set(r.escalated_by.map((e) => e.control_code));
  return (
    <div className={`gapblock gap-${r.health}`}>
      <div className="gaphead">
        <div className="gapname">{r.ce_name}</div>
        <div className="gapmeta">
          <HealthPill health={r.health} />
          <span className="gapval tnum">
            <b>{fmtLevel(r.actual)}</b> <span className="muted">/ {fmtLevel(r.target)}</span>
          </span>
        </div>
      </div>
      <div className="gapsum">{gapControlSummary(controls)}</div>
      <div className="gapctrls">
        {below.map((cs) => (
          <GapControlRow
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

  const deficits = gaps.filter((r) => r.health === "deficit").length;
  const minors = gaps.length - deficits;
  const gapSummary =
    gaps.length === 0
      ? "Every competency is at or above target."
      : `${gaps.length} development area${gaps.length === 1 ? "" : "s"} — ` +
        [
          deficits > 0 ? `${deficits} capability deficit${deficits === 1 ? "" : "s"}` : null,
          minors > 0 ? `${minors} minor gap${minors === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const shown = gaps.slice(0, VISIBLE_GAPS);
  const rest = gaps.slice(VISIBLE_GAPS);

  const block = (r: CeResult) => (
    <GapBlock
      key={r.ce_code}
      r={r}
      controls={controlBreakdown(fw.data, assessment, r.ce_code)}
      indicatorOf={indicatorOf}
      labelOf={fw.labelOf}
    />
  );

  return (
    <div className="sgcols">
      <section className="sgcol">
        <div className="cap">STRENGTHS · most clear of target first</div>
        {strengths.length === 0 ? (
          <p className="note">No competency is at or above target yet.</p>
        ) : (
          <div className="strengths">
            {strengths.map((r) => (
              <StrengthRow key={r.ce_code} r={r} />
            ))}
          </div>
        )}
      </section>

      <section className="sgcol">
        <div className="cap">DEVELOPMENT AREAS · most serious first</div>
        <p className="sgsummary">{gapSummary}</p>
        {gaps.length > 0 && (
          <>
            {shown.map(block)}
            {rest.length > 0 && (
              <details className="moregaps">
                <summary>Show {rest.length} more competenc{rest.length === 1 ? "y" : "ies"}</summary>
                <div className="moregaps-body">{rest.map(block)}</div>
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}
