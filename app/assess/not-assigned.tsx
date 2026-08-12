import Link from "@/app/link";

/**
 * Shown when someone opens the self-assessment and has no live assessment.
 *
 * Two different situations, and they must not read the same. Never assigned is
 * routine. Archived means they may have filled the thing in and come back to
 * find it gone — telling that person "you were never assigned one" is the kind
 * of small dishonesty that costs an assessment tool its credibility (see N13).
 */
export default function NotAssigned({
  cycle,
  archived,
}: {
  cycle: string;
  archived?: { archived_at?: string | null; archived_reason?: string | null } | null;
}) {
  return (
    <div className="section reading">
      <div className="card pad">
        {archived ? (
          <>
            <h2 style={{ fontSize: "1.125rem", fontWeight: 650, marginBottom: 6 }}>
              Your {cycle} assessment was withdrawn
            </h2>
            <p className="note">
              The Head of PMO archived it
              {archived.archived_at ? ` on ${archived.archived_at.slice(0, 10)}` : ""}
              {archived.archived_reason ? `: “${archived.archived_reason}”` : "."} Nothing
              you entered was destroyed — it is kept on the record — but it no longer
              counts toward this cycle and cannot be edited. Speak to the Head of PMO
              if that looks wrong.
            </p>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: "1.125rem", fontWeight: 650, marginBottom: 6 }}>
              No assessment has been assigned to you
            </h2>
            <p className="note">
              The Head of PMO assigns each assessment cycle. You have not been assigned
              the {cycle} cycle, so there is nothing to fill in yet — you will be able to
              start here as soon as you are.
            </p>
          </>
        )}
        <div style={{ marginTop: 16 }}>
          <Link className="btn btn-secondary" href="/">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
