import Link from "next/link";
import { counts, framework } from "@/lib/framework";

export default function Home() {
  return (
    <div className="section">
      <div className="card pad">
        <h2 style={{ fontSize: 22, fontWeight: 680, marginBottom: 6 }}>
          Assess project managers against ICB4
        </h2>
        <p className="note" style={{ fontSize: 14 }}>
          {framework.framework} · {counts.active} active controls across {counts.ces} competence
          elements · rated on the {framework.scale.name} ({framework.scale.axis} axis).
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
          <Link className="btn btn-primary" href="/assess">Start self-assessment</Link>
          <Link className="btn btn-secondary" href="/results">View results</Link>
          <Link className="btn btn-secondary" href="/review">Review &amp; approve</Link>
          <Link className="btn btn-secondary" href="/admin">Framework admin</Link>
        </div>
      </div>

      <div className="tiles" style={{ marginTop: 20 }}>
        <div className="card tile">
          <div className="lbl">Controls</div>
          <div className="big tnum">{counts.active}<small> / {counts.total}</small></div>
          <div className="note" style={{ marginTop: 8 }}>{counts.inactive} inactive, excluded from every rollup</div>
        </div>
        <div className="card tile">
          <div className="lbl">Competence elements</div>
          <div className="big tnum">{counts.ces}</div>
          <div className="note" style={{ marginTop: 8 }}>Perspective 5 · People 10 · Practice 13</div>
        </div>
        <div className="card tile">
          <div className="lbl">Measures</div>
          <div className="big tnum">{counts.measures}</div>
          <div className="note" style={{ marginTop: 8 }}>Reference only — never scored</div>
        </div>
      </div>
    </div>
  );
}
