import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { listPeople } from "@/lib/db/people";
import { currentCycle } from "@/lib/db/assessment";
import { addPersonAction, resetPasswordAction } from "./actions";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  assessee: "Project manager",
  assessor: "Assessor",
  admin: "Administrator",
};

/**
 * People — the allowlist, editable without a terminal.
 *
 * Until this existed, adding a colleague meant cloning the repo and running
 * `npm run invite`. An assessment tool whose administrator cannot add a person
 * is not administrable.
 */
export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; added?: string; reset?: string }>;
}) {
  const { error, added, reset } = await searchParams;
  const admin = await requireRole("admin");
  const cycle = currentCycle();
  const people = await listPeople(cycle);

  const pms = people.filter((p) => p.role === "assessee").length;

  return (
    <div className="section">
      <div className="sec-head">
        <h2>People</h2>
        <span className="rule" />
        <span className="eyebrow">
          {people.length} on the allowlist · {pms} project manager{pms === 1 ? "" : "s"}
        </span>
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {added && (
        <div className="banner banner-ok" role="status">
          Added {added}. Give them the password you just set — they will be made to
          replace it the first time they sign in.
        </div>
      )}
      {reset && (
        <div className="banner banner-ok" role="status">
          Password reset. They must replace it on their next sign-in.
        </div>
      )}

      <div className="card pad" style={{ marginBottom: 20 }}>
        <div className="cap" style={{ marginBottom: 10 }}>ADD SOMEONE</div>
        <form action={addPersonAction}>
          <div className="cols">
            <div className="field">
              <label htmlFor="full_name">Full name</label>
              <input className="input" id="full_name" name="full_name" required />
            </div>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input className="input" id="email" name="email" type="email" required />
            </div>
          </div>

          <div className="cols" style={{ marginTop: 14 }}>
            <div className="field">
              <label htmlFor="job_title">Job title</label>
              <input className="input" id="job_title" name="job_title" placeholder="Project Manager" />
            </div>
            <div className="field">
              <label htmlFor="role">Role</label>
              <select className="input" id="role" name="role" defaultValue="assessee">
                <option value="assessee">Project manager — takes the assessment</option>
                <option value="assessor">Assessor — reviews and approves</option>
                <option value="admin">Administrator — everything</option>
              </select>
            </div>
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="password">Starting password</label>
            <input
              className="input"
              id="password"
              name="password"
              type="text"
              minLength={10}
              required
              placeholder="At least 10 characters"
            />
            <div className="note lede" style={{ marginTop: 6 }}>
              Set one per person rather than reusing a shared value — a shared
              password lets anyone who learns it sign in as any colleague who has
              not logged in yet. They must replace it on first sign-in, so it is
              only ever valid once.
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" type="submit">Add person</button>
          </div>
        </form>
      </div>

      <div className="card pad">
        <div className="cap" style={{ marginBottom: 10 }}>ON THE ALLOWLIST</div>
        <div className="tablewrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Cycle {cycle}</th>
                <th>Reset password</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.full_name}
                    {p.job_title && <div className="note">{p.job_title}</div>}
                    {p.must_change_password && (
                      <span className="tick tick-todo">must set password</span>
                    )}
                  </td>
                  <td className="note">{p.email}</td>
                  <td>{ROLE_LABEL[p.role] ?? p.role}</td>
                  <td>
                    {p.assessment_state ? (
                      <>
                        {p.assessment_state.replace("_", " ")}
                        <div className="note tnum">{p.scored} scored</div>
                      </>
                    ) : (
                      <span className="muted">not started</span>
                    )}
                  </td>
                  <td>
                    {p.id === admin.id ? (
                      <Link href="/change-password">Change your own</Link>
                    ) : (
                      <form action={resetPasswordAction} className="revise">
                        <input type="hidden" name="user_id" value={p.id} />
                        <input
                          className="input"
                          name="password"
                          type="text"
                          minLength={10}
                          required
                          placeholder="New password"
                          aria-label={`New password for ${p.full_name}`}
                        />
                        <button className="btn btn-secondary btn-sm" type="submit">Reset</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="note lede" style={{ marginTop: 14 }}>
          Removing someone is deliberately not here yet: deleting an `app_user`
          row cascades and destroys their assessment, scores and frozen targets.
          Use <code>npm run invite remove</code>, which refuses when they hold
          assessment data.
        </p>
      </div>
    </div>
  );
}
