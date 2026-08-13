import {
  controlBreakdown, fmtLevel, healthOf, HEALTH_LABEL, rollupAll, rollupAreas, sortByGap,
} from "@/lib/rollup";
import { areaNarrative, tidyIndicator } from "@/lib/narrative";
import { AreaRadar } from "./area-radar";
import type { Assessment, CeResult, ControlScore, Framework, Health, Level } from "@/lib/types";

/**
 * The capability report — area tiles, radar, per-area narrative, and the
 * competency-by-competency breakdown with control drill-down.
 *
 * Extracted from `/results` so the PMO analysis screen can show the SAME report
 * (a person's capability) beside their pace, without a second copy of the
 * rollup-to-markup mapping drifting from this one. Callers supply the framework
 * and an APPROVED assessment; this renders the analytical body only (no person
 * header — the caller owns that, because /results and /analysis title it
 * differently).
 */

/**
 * Bar geometry for the 0–5 results scale, shared with the strengths-gaps view so
 * the two readings of the same rollup place a bar identically. Exported rather
 * than re-declared there — the scale ceiling lives in one place (the rating scale
 * is a swappable module; a second `5` is exactly the copy that gets missed).
 */
export const MAX = 5;
export const pct = (v: number) => `${(v / MAX) * 100}%`;

export function HealthPill({ health }: { health: Health | null }) {
  if (!health) return <span className="muted">—</span>;
  return (
    <span className={`pill pill-${health}`}>
      <span className="dot" />
      {HEALTH_LABEL[health]}
    </span>
  );
}

/**
 * Some ICB4 indicators run long (41 of 132 active exceed 80 chars even after
 * `tidyIndicator` strips extraction junk), and the meta line sits in a fixed
 * 190px column. Clip the DISPLAYED label so one competency's weakest control
 * cannot become a wall of text under its name; the full text rides in the row's
 * `title` for hover. Clip on a word boundary where one is near the end.
 */
export function clip(s: string, n = 66): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > n - 18 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

function escalationNote(
  r: CeResult,
  label: (code: string) => string,
): { display: string; full: string } | null {
  if (!r.escalation_drove_health || r.escalated_by.length === 0) return null;
  const [first, ...rest] = r.escalated_by;
  const more = rest.length === 0 ? "" : ` and ${rest.length} more`;
  const t = label(first.control_code);
  const tail = `”, scored ${first.level} against target ${first.target}${more}`;
  return {
    display: `deficit driven by “${clip(t)}${tail}`,
    full: `deficit driven by “${t}${tail}`,
  };
}

/**
 * The line under a competency name, naming the control(s) that drive its verdict
 * BY INDICATOR TEXT rather than by code (4.4.10.1 means nothing to a PM — the
 * indicator it stands for does). `label` resolves a control code to its ICB4
 * indicator, falling back to the code if the framework has no text for it.
 */
function metaLine(
  r: CeResult,
  label: (code: string) => string,
): { display: string; full: string } | null {
  const display: string[] = [];
  const full: string[] = [];
  if (r.weakest) {
    const t = label(r.weakest.control_code);
    display.push(`weakest: “${clip(t)}” (${r.weakest.level})`);
    full.push(`weakest: “${t}” (${r.weakest.level})`);
  }
  const esc = escalationNote(r, label);
  if (esc) {
    display.push(esc.display);
    full.push(esc.full);
  }
  if (!display.length) return null;
  return { display: display.join(" · "), full: full.join(" · ") };
}

/**
 * One control inside a competency's drill-down (Phase 1). Indicator + a compact
 * score bar + score/target LABEL. "Exceptions only" colour (owner's Quiet 2):
 * on/above-target rows render neutral via CSS; colour and the state dot appear
 * only when the control is below its own target (`cs.below`).
 */
function DrillRow({
  cs, indicator, labelOf,
}: {
  cs: ControlScore;
  indicator: string;
  labelOf: (n: Level | null) => string;
}) {
  return (
    <div className={`ctrlrow${cs.below ? " is-gap" : ""}`} title={indicator}>
      <div className="ctrlname">{clip(indicator, 92)}</div>
      <div className="track track-sm">
        {cs.target !== null && <div className="target" style={{ left: pct(cs.target) }} />}
        {cs.level !== null && cs.health && (
          <div className={`actual ${cs.health}`} style={{ width: pct(cs.level) }} />
        )}
      </div>
      <div className="ctrlval">
        {cs.below && cs.health && <span className={`dot-h ${cs.health}`} aria-hidden="true" />}
        <b className="tnum">{labelOf(cs.level)}</b>{" "}
        <span className="muted tnum">/ {labelOf(cs.target)}</span>
      </div>
    </div>
  );
}

/**
 * A competency row that expands to its controls (Phase 1 drill-down). Every
 * competency is COLLAPSED by default (owner, 2026-08-12). Native `<details>`,
 * so the report stays fully server-rendered with no client JS.
 */
function Bar({
  r, label, breakdown, labelOf,
}: {
  r: CeResult;
  label: (code: string) => string;
  breakdown: ControlScore[];
  labelOf: (n: Level | null) => string;
}) {
  const meta = metaLine(r, label);
  return (
    <details className="dd">
      <summary>
        <div className="barrow">
          <div className="name">
            {r.ce_name}
            {meta && (
              <small title={meta.full !== meta.display ? meta.full : undefined}>{meta.display}</small>
            )}
          </div>
          <div className="track">
            {r.target !== null && <div className="target" style={{ left: pct(r.target) }} />}
            {r.actual !== null && r.health && (
              <div className={`actual ${r.health}`} style={{ width: pct(r.actual) }} />
            )}
          </div>
          <div className="val">
            <b className="tnum">{fmtLevel(r.actual)}</b>{" "}
            <span className="muted tnum">/ {fmtLevel(r.target)}</span>{" "}
            <HealthPill health={r.health} />
          </div>
        </div>
      </summary>
      <div className="dd-body">
        {breakdown.map((cs) => (
          <DrillRow key={cs.code} cs={cs} indicator={label(cs.code)} labelOf={labelOf} />
        ))}
      </div>
    </details>
  );
}

export function CapabilityReport({
  fw,
  assessment,
}: {
  fw: { data: Framework; labelOf: (n: Level | null) => string };
  assessment: Assessment;
}) {
  const results = rollupAll(fw.data, assessment);
  const areas = rollupAreas(results);

  // Resolve a control code to its ICB4 indicator text, so the report names
  // controls by what they mean, not by "4.4.10.1".
  const ctrlText = new Map(fw.data.controls.map((c) => [c.code, c.indicator ?? c.code]));
  const controlLabel = (code: string) => tidyIndicator(ctrlText.get(code) ?? code);

  return (
    <>
      <div className="tiles">
        {areas.map((ar) => {
          /*
           * The SAME healthOf the CE rows use (rollup-spec §4: the thresholds are
           * defined in exactly one place). This was once an inlined copy of the
           * three tiers with a bare `<= 0.5`, and it survived the 2026-08-08
           * change that put an epsilon on the real one — leaving the copy MORE
           * exposed than the original, because an area figure is a mean of means
           * over 5/10/13 competencies whose own denominators are 3-6. Five CEs at
           * target 14/6 against actual 11/6 gives 0.5000000000000002 and painted
           * the deficit colour on an area exactly half a level short. Areas have
           * no health of their own (§5) — this only picks a bar colour, so a null
           * rolls up to "minor" exactly as before. Do not re-inline it.
           */
          const health: Health = healthOf(ar.actual, ar.target, false) ?? "minor";
          const width =
            ar.actual === null || ar.target === null || ar.target === 0
              ? "0%"
              : `${Math.min(100, (ar.actual / ar.target) * 100)}%`;
          return (
            <div className="tile" key={ar.area}>
              <div className="lbl">
                {ar.area} · {ar.ce_count} elements
              </div>
              <div className="big tnum">
                {fmtLevel(ar.actual)}
                <small> / {fmtLevel(ar.target)}</small>
              </div>
              <div className="mini">
                <i style={{ width, background: `var(--${health})` }} />
              </div>
            </div>
          );
        })}
      </div>

      <AreaRadar areas={areas} />

      <div className="narrative">
        {areas.map((ar) => (
          <p key={ar.area}>
            {areaNarrative(ar, results.filter((r) => r.area === ar.area), controlLabel)}
          </p>
        ))}
      </div>

      <div className="cap" style={{ marginBottom: 6 }}>
        CAPABILITY BY COMPETENCE ELEMENT · grouped by area · most serious first · actual vs target on 0–5
      </div>
      {areas.map((ar) => {
        const rows = sortByGap(results.filter((r) => r.area === ar.area));
        return (
          <section className="cesection" key={ar.area}>
            <div className="cehead">
              <h4>{ar.area}</h4>
              <span className="cehead-val tnum">
                {fmtLevel(ar.actual)} <span className="muted">/ {fmtLevel(ar.target)}</span>
              </span>
            </div>
            {rows.map((r) => (
              <Bar
                key={r.ce_code}
                r={r}
                label={controlLabel}
                breakdown={controlBreakdown(fw.data, assessment, r.ce_code)}
                labelOf={fw.labelOf}
              />
            ))}
          </section>
        );
      })}

      <div className="scaleline">
        <div />
        <div className="ticks">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
        <div />
      </div>

      <div className="legend">
        <span><i style={{ background: "var(--above)" }} />Above target</span>
        <span><i style={{ background: "var(--ready)" }} />Role Ready</span>
        <span><i style={{ background: "var(--minor)" }} />Minor Gap</span>
        <span><i style={{ background: "var(--deficit)" }} />Capability Deficit</span>
        <span><i style={{ background: "var(--ink)", opacity: 0.6 }} />Target</span>
      </div>

      <p className="note" style={{ marginTop: 14 }}>
        Actual is the mean of approved scores across each element’s active controls; the
        weakest control is named alongside so a single serious gap is not absorbed by the
        average. This report supports a decision — it does not approve, reject or gate one.
      </p>
    </>
  );
}
