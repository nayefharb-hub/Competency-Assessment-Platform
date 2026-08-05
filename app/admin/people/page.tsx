import Link from "@/app/link";
import { requireRole } from "@/lib/auth";
import { listPeople } from "@/lib/db/people";
import { currentCycle } from "@/lib/db/assessment";
import { getFramework } from "@/lib/framework";
import { daysSince, hasStalled } from "@/lib/stall";
import {
  addPersonAction, archiveAction, assignAction, resetPasswordAction,
  restoreAction, unassignAction,
} from "./actions";

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
  searchParams: Promise<{
    error?: string; added?: string; reset?: string;
    assigned?: string; withdrawn?: string; archived?: string; restored?: string;
  }>;
}) {
  const { error, added, reset, assigned, withdrawn, archived, restored } =
    await searchParams;
  const admin = await requireRole("admin");
  const cycle = currentCycle();
  const [people, fw] = await Promise.all([listPeople(cycle), getFramework()]);
  const activeControlCount = fw.activeControls.length;
  // One clock for the whole render, so two rows cannot disagree about "today".
  const now = Date.now();

  const pms = people.filter((p) => p.role === "assessee").length;
  const unassigned = people.filter((p) => p.assessment_id === null);
  const assignedCount = people.length - unassigned.length;

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
      {assigned && (
        <div className="banner banner-ok" role="status">
          {assigned === "0"
            ? "Everyone you picked already had this cycle — nothing changed."
            : `Assigned the ${cycle} cycle to ${assigned} ${assigned === "1" ? "person" : "people"}. They can start now.`}
        </div>
      )}
      {withdrawn && (
        <div className="banner banner-ok" role="status">
          Assignment withdrawn. Nothing was scored, so nothing was lost.
        </div>
      )}
      {archived && (
        <div className="banner banner-ok" role="status">
          Archived. It is out of the review list and every figure, and the
          completion panel now says so — the scores and timings are kept, so the
          number can still be reconciled later. You can restore it from here.
        </div>
      )}
      {restored && (
        <div className="banner banner-ok" role="status">
          Restored. It counts again, exactly as it did before.
        </div>
      )}

      <div className="card pad" style={{ marginBottom: 20 }}>
        <div className="cap" style={{ marginBottom: 10 }}>
          ASSIGN THE {cycle} CYCLE
        </div>
        <p className="note lede" style={{ marginBottom: 14 }}>
          Nobody has an assessment until you assign one. That is what makes the
          completion figure mean something: {assignedCount} assigned is{" "}
          {assignedCount} people asked, not {people.length} people who happen to
          hold a login.
        </p>

        {unassigned.length === 0 ? (
          <p className="note">
            Everyone on the allowlist has the {cycle} cycle.{" "}
            <Link href="/review">See how they are getting on</Link>.
          </p>
        ) : (
          <form action={assignAction}>
            <ul className="picklist">
              {unassigned.map((p) => (
                <li key={p.id}>
                  <label className="opt">
                    <input
                      type="checkbox"
                      name="assignee"
                      value={p.id}
                      defaultChecked={p.role === "assessee"}
                    />
                    <span>
                      <b>{p.full_name}</b>
                      <span className="gloss">
                        {ROLE_LABEL[p.role] ?? p.role}
                        {p.job_title ? ` · ${p.job_title}` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="btn btn-accent" type="submit">
                Assign selected
              </button>
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              Project managers are ticked by default. Assessors and admins are
              listed too — assigning yourself is how you walk the loop end to end,
              and it counts like anyone else.
            </p>
          </form>
        )}
      </div>

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
          <table className="grid stacked">
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
                  <td data-label="Name">
                    {p.full_name}
                    {p.job_title && <div className="note">{p.job_title}</div>}
                    {p.must_change_password && (
                      <span className="tick tick-todo">must set password</span>
                    )}
                  </td>
                  <td className="note" data-label="Email">{p.email}</td>
                  <td data-label="Role">{ROLE_LABEL[p.role] ?? p.role}</td>
                  <td data-label={`Cycle ${cycle}`}>
                    {p.assessment_state ? (
                      <>
                        {p.assessment_state.replace("_", " ")}
                        <div className="note tnum">{p.scored} scored</div>
                        {/* Last activity, and a quiet marker when a draft has
                            stopped moving (D16). Completion alone renders a PM
                            who is 40% through and scoring daily identically to
                            one who stopped three weeks ago. No email, no
                            nagging — it is an invitation to look. */}
                        <div className="note">
                          {p.last_scored
                            ? <>last scored {daysSince(p.last_scored, now) === 0
                                ? "today"
                                : `${daysSince(p.last_scored, now)}d ago`}</>
                            : "not started"}
                          {hasStalled({
                            lastScored: p.last_scored, scored: p.scored,
                            total: activeControlCount, state: p.assessment_state,
                          }, now) && (
                            <span className="pill pill-deficit" style={{ marginLeft: 8 }}>
                              stalled
                            </span>
                          )}
                        </div>
                        {p.assessment_state === "draft" && p.scored === 0 ? (
                          // Nothing to lose yet, so this is a plain undo.
                          <form action={unassignAction}>
                            <input type="hidden" name="assessment_id" value={p.assessment_id ?? ""} />
                            <button className="btn btn-secondary btn-sm" type="submit">
                              Withdraw
                            </button>
                          </form>
                        ) : (
                          // Work exists. Archiving keeps it — and keeps the
                          // completion figure reconcilable — where a delete
                          // would move the headline number silently (N6).
                          <form action={archiveAction} className="revise">
                            <input type="hidden" name="assessment_id" value={p.assessment_id ?? ""} />
                            <input
                              className="input"
                              name="reason"
                              required
                              placeholder="Why archive?"
                              aria-label={`Reason for archiving ${p.full_name}'s assessment`}
                            />
                            <button className="btn btn-secondary btn-sm" type="submit">
                              Archive
                            </button>
                          </form>
                        )}
                      </>
                    ) : p.archived_id ? null : (
                      <span className="muted">not assigned</span>
                    )}

                    {/* Shown even when a live assessment exists beside it. An
                        archived record that disappears the moment the person is
                        re-assigned is not history, it is a delete with extra
                        steps — and it would leave Restore unreachable. */}
                    {p.archived_id && (
                      <div style={{ marginTop: p.assessment_state ? 8 : 0 }}>
                        <span className="tick tick-todo">archived</span>
                        <div className="note">
                          {p.archived_at?.slice(0, 10)}
                          {p.archived_reason ? ` — ${p.archived_reason}` : ""}
                        </div>
                        <form action={restoreAction}>
                          <input type="hidden" name="assessment_id" value={p.archived_id} />
                          <button className="btn btn-secondary btn-sm" type="submit">
                            Restore
                          </button>
                        </form>
                      </div>
                    )}
                  </td>
                  <td data-label="Password">
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
          <b>Archive, don’t delete.</b> Archiving takes an assessment out of the
          review list and out of every figure, but keeps its scores and its
          timings — so a completion number already reported upward can still be
          reconciled afterwards, and the review panel says how many were
          excluded. Archiving is reversible; you can restore from this table.
        </p>
        <p className="note lede" style={{ marginTop: 10 }}>
          Removing a <i>person</i> is deliberately not here: deleting an
          <code> app_user</code> row cascades and destroys their assessment,
          scores and frozen targets outright, with no record that any of it
          existed. Use <code>npm run invite remove</code>, which refuses when
          they hold assessment data — and archive the assessment first if what
          you actually want is for it to stop counting.
        </p>
      </div>
    </div>
  );
}
