import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getFramework } from "@/lib/framework";

export const dynamic = "force-dynamic";

/** Control picker for the admin editor — includes inactive controls, which the
 *  assessment index deliberately hides. */
export default async function AdminControlsIndex() {
  await requireRole("admin");
  const fw = await getFramework();

  const byCe = fw.data.competence_elements.map((ce) => ({
    ce,
    controls: fw.controls.filter((c) => c.ce_code === ce.code),
  }));

  return (
    <div className="section">
      <div className="sec-head">
        <h2>All controls</h2>
        <span className="rule" />
        <span className="eyebrow">
          {fw.counts.total} total · {fw.counts.inactive} inactive
        </span>
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
                      · {g.controls.filter((c) => c.active).length} active of {g.controls.length}
                      {" · target "}
                      {fw.data.ce_targets.find((t) => t.ce_code === g.ce.code)?.target ?? "—"}
                    </span>
                  </div>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                    {g.controls.map((c) => (
                      <li key={c.code} style={{ padding: "3px 0" }}>
                        <Link href={`/admin?c=${c.code}`} style={{ fontSize: 13.5 }}>
                          <span className="tnum" style={{ fontWeight: 600 }}>{c.code}</span>{" "}
                          <span style={{ color: "var(--ink)" }}>{c.indicator}</span>
                        </Link>{" "}
                        <span className="tick tick-todo">
                          target {c.target_level ?? "—"} · {c.priority ?? "—"}
                        </span>
                        {!c.active && <span className="tick tick-off">inactive</span>}
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
