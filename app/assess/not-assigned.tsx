import Link from "next/link";

/**
 * Shown when someone opens the self-assessment before an admin has assigned
 * them a cycle. Visiting a page used to create the assessment; now it doesn't,
 * so this state is real and has to say something true rather than pretend the
 * sheet is merely empty.
 */
export default function NotAssigned({ cycle }: { cycle: string }) {
  return (
    <div className="section reading">
      <div className="card pad">
        <h2 style={{ fontSize: 18, fontWeight: 650, marginBottom: 6 }}>
          No assessment has been assigned to you
        </h2>
        <p className="note">
          The Head of PMO assigns each assessment cycle. You have not been assigned the{" "}
          {cycle} cycle, so there is nothing to fill in yet — you will be able to start
          here as soon as you are.
        </p>
        <div style={{ marginTop: 16 }}>
          <Link className="btn btn-secondary" href="/">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
