import { controlByCode, labelOf } from "@/lib/framework";
import { demoAssessment, reviewCoverage } from "@/lib/demo";

export const dynamic = "force-static";

/**
 * Assessor review-and-revise.
 *
 * The assessor's score is authoritative and pre-filled from the PM's self-score:
 * accept as-is, or override specific controls. Both scores are kept; the
 * self-vs-assessor delta is itself signal.
 */
export default function ReviewPage() {
  const a = demoAssessment;
  const edited = a.scores.filter((s) => s.assessor_touched);
  const shown = [...edited.slice(0, 8), ...a.scores.filter((s) => !s.assessor_touched).slice(0, 4)];
  const coverage = Math.round((reviewCoverage.touched / reviewCoverage.total) * 100);

  return (
    <div className="section">
      <div className="sec-head">
        <h2>Review &amp; revise — {a.assessee_name}</h2>
        <span className="rule" />
        <span className="eyebrow">cycle {a.cycle}</span>
      </div>

      <div className="card pad">
        <p className="note" style={{ marginBottom: 14 }}>
          Every control is pre-filled with the PM’s self-score. Accept the assessment as it
          stands, or override the controls you disagree with — your score is the one that
          appears in the results.
        </p>

        {shown.map((s) => {
          const c = controlByCode(s.control_code);
          const changed = s.self_level !== s.assessor_level;
          return (
            <div className="rrow" key={s.control_code}>
              <div className="rcode tnum">{s.control_code}</div>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>{c?.indicator}</div>
                <div className="note" style={{ marginTop: 3 }}>
                  PM self-scored{" "}
                  <b className="tnum">
                    {labelOf(s.self_level)} ({s.self_level})
                  </b>{" "}
                  ·{" "}
                  {changed ? (
                    <>
                      you set{" "}
                      <b className="tnum" style={{ color: "var(--accent)" }}>
                        {labelOf(s.assessor_level)} ({s.assessor_level})
                      </b>
                    </>
                  ) : (
                    <>
                      agreed{" "}
                      <b className="tnum">
                        {labelOf(s.assessor_level)} ({s.assessor_level})
                      </b>
                    </>
                  )}
                </div>
                <div style={{ marginTop: 8 }}>
                  {s.assessor_touched ? (
                    <span className="edited">✎ Edited by assessor</span>
                  ) : (
                    <span className="accepted">✓ Accepted as scored</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: 18,
          }}
        >
          <button className="btn btn-accent" type="button">
            Approve assessment
          </button>
          <button className="btn btn-ghost" type="button">
            Accept all remaining
          </button>
          <span className="note">
            Review coverage <b className="tnum">{coverage}%</b> ·{" "}
            <span className="tnum">{reviewCoverage.touched}</span> /{" "}
            <span className="tnum">{reviewCoverage.total}</span> controls revised
          </span>
        </div>
      </div>
    </div>
  );
}
