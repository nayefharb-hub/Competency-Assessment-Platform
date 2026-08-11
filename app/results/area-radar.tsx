import { fmtLevel } from "@/lib/rollup";
import type { AreaResult } from "@/lib/types";

/**
 * A 3-axis area radar (People · Practice · Perspective), actual against target.
 *
 * Hand-drawn inline SVG, no charting dependency and no client component — the
 * whole results screen stays server-rendered. A 3-axis radar is a triangle, and
 * a triangle is legible where the 28-competency version is not (rollup-spec §7,
 * DESIGN.md decision log 2026-08-10). Colours, grid and text all come from the
 * same CSS variables as the rest of the page, so it themes with everything else.
 *
 * The radar is the centre of attention on the results screen (owner, N-results):
 * large, centred in its panel, with the per-area figures read beneath it rather
 * than in a side legend. Geometry is parametric off CX/CY/R so the size can move
 * without re-hand-placing a single label — axis and label positions are computed
 * from the axis angle, not typed in.
 *
 * Geometry: an equilateral triangle centred at (CX,CY), radius R = level 5.
 * Axis i sits at (-90 + 120·i)°, so the three areas take top / lower-right /
 * lower-left in the order rollupAreas() returns them.
 */
const CX = 160;
const CY = 146;
const R = 110;
const MAX = 5;
const AXES = [-90, 30, 150]; // degrees, aligned to rollupAreas order

function pt(i: number, value: number): [number, number] {
  const a = (AXES[i] * Math.PI) / 180;
  const r = (R * value) / MAX;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function poly(values: number[]): string {
  return values.map((v, i) => pt(i, v).map((n) => n.toFixed(2)).join(",")).join(" ");
}

/** Vertex label position, computed from the axis angle — no hand-placed coords. */
function labelPos(i: number): { x: number; y: number } {
  const a = (AXES[i] * Math.PI) / 180;
  const lr = R + 16;
  const x = CX + lr * Math.cos(a);
  // top vertex sits above its point; the two lower vertices sit below theirs
  const y = CY + lr * Math.sin(a) + (AXES[i] === -90 ? -4 : 15);
  return { x, y };
}

export function AreaRadar({ areas }: { areas: AreaResult[] }) {
  const targets = areas.map((a) => a.target);
  const actuals = areas.map((a) => a.actual);
  const haveTargets = targets.every((t): t is number => t !== null);
  const haveActuals = actuals.every((v): v is number => v !== null);

  const label =
    "Area radar. " +
    areas
      .map((a) => `${a.area} actual ${fmtLevel(a.actual)}, target ${fmtLevel(a.target)}`)
      .join("; ");

  return (
    <div className="radarwrap">
      <svg
        className="arearadar"
        width="320"
        height="250"
        viewBox="0 0 320 250"
        role="img"
        aria-label={label}
      >
        {/* grid rings, one per level */}
        {[1, 2, 3, 4, 5].map((v) => (
          <polygon key={v} className="grid" points={poly([v, v, v])} />
        ))}
        {/* spokes to the outer vertices */}
        {areas.map((_, i) => {
          const [x, y] = pt(i, MAX);
          return <line key={i} className="spoke" x1={CX} y1={CY} x2={x} y2={y} />;
        })}
        {/* level ticks along the top spoke */}
        {[1, 2, 3, 4, 5].map((v) => (
          <text key={v} className="tick" x={CX + 4} y={CY - (R * v) / MAX + 3}>
            {v}
          </text>
        ))}
        {haveTargets && <polygon className="tgt" points={poly(targets as number[])} />}
        {haveActuals && (
          <>
            <polygon className="act" points={poly(actuals as number[])} />
            {(actuals as number[]).map((v, i) => {
              const [x, y] = pt(i, v);
              return <circle key={i} className="dot" cx={x} cy={y} r={4} />;
            })}
          </>
        )}
        {/* axis labels */}
        {areas.map((a, i) => {
          const { x, y } = labelPos(i);
          return (
            <text key={a.area} className="lab" x={x} y={y} textAnchor="middle">
              {a.area}
            </text>
          );
        })}
      </svg>

      <div className="rvalues">
        {areas.map((a) => (
          <span className="arow" key={a.area}>
            {a.area}
            <b>
              {fmtLevel(a.actual)} <span className="muted">/ {fmtLevel(a.target)}</span>
            </b>
          </span>
        ))}
      </div>

      <div className="rkey">
        <span className="k"><span className="sw act" />Actual</span>
        <span className="k"><span className="sw tgt" />Target</span>
      </div>
    </div>
  );
}
