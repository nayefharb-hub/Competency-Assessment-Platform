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
 * Geometry: an equilateral triangle centred at (120,110), radius 80 = level 5.
 * Axis i sits at (-90 + 120·i)°, so the three areas take top / lower-right /
 * lower-left in the order rollupAreas() returns them.
 */
const CX = 120;
const CY = 110;
const R = 80;
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

// Vertex label anchors, aligned to the three fixed axes.
const LABELS = [
  { x: CX, y: 15, anchor: "middle" as const },
  { x: 198, y: 168, anchor: "middle" as const },
  { x: 42, y: 168, anchor: "middle" as const },
];

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
        width="240"
        height="220"
        viewBox="0 0 240 220"
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
          <text key={v} className="tick" x={123} y={CY - (R * v) / MAX + 3}>
            {v}
          </text>
        ))}
        {haveTargets && <polygon className="tgt" points={poly(targets as number[])} />}
        {haveActuals && (
          <>
            <polygon className="act" points={poly(actuals as number[])} />
            {(actuals as number[]).map((v, i) => {
              const [x, y] = pt(i, v);
              return <circle key={i} className="dot" cx={x} cy={y} r={3} />;
            })}
          </>
        )}
        {/* axis labels */}
        {areas.map((a, i) => (
          <text key={a.area} className="lab" x={LABELS[i].x} y={LABELS[i].y} textAnchor={LABELS[i].anchor}>
            {a.area}
          </text>
        ))}
      </svg>

      <div className="rlegend">
        <span className="k"><span className="sw act" />Actual</span>
        <span className="k"><span className="sw tgt" />Target</span>
        {areas.map((a) => (
          <span className="arow" key={a.area}>
            {a.area}
            <span>
              <b>{fmtLevel(a.actual)}</b> / {fmtLevel(a.target)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
