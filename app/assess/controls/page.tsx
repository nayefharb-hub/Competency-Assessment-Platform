import Link from "next/link";
import { activeControls, framework } from "@/lib/framework";

export const dynamic = "force-static";

/** Control index — lets a PM jump straight back to any control. */
export default function ControlsIndex() {
  const byCe = framework.competence_elements.map((ce) => ({
    ce,
    controls: activeControls.filter((c) => c.ce_code === ce.code),
  }));

  return (
    <div className="section">
      <div className="sec-head">
        <h2>All controls</h2>
        <span className="rule" />
        <span className="eyebrow">{activeControls.length} active · jump to any</span>
      </div>

      {(["Perspective", "People", "Practice"] as const).map((area) => (
        <div key={area} style={{ marginBottom: 22 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>{area}</div>
          <div className="card pad">
            {byCe
              .filter((g) => g.ce.area === area)
              .map((g) => (
                <div key={g.ce.code} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>
                    {g.ce.code} {g.ce.name}{" "}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      · {g.controls.length} controls
                    </span>
                  </div>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                    {g.controls.map((c) => (
                      <li key={c.code} style={{ padding: "3px 0" }}>
                        <Link href={`/assess?c=${c.code}`} style={{ fontSize: 13.5 }}>
                          <span className="tnum" style={{ fontWeight: 600 }}>{c.code}</span>{" "}
                          <span style={{ color: "var(--ink)" }}>{c.indicator}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
