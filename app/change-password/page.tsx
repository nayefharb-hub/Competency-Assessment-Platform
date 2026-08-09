import { requireUser } from "@/lib/auth";
import { changePasswordAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Set your own password.
 *
 * Two audiences: someone who was given a password by an admin and must replace
 * it before doing anything else, and anyone who just wants to change theirs.
 * The first case is why `skipPasswordGate` exists — this is the only route
 * requireUser lets a flagged user reach.
 */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const user = await requireUser({ skipPasswordGate: true });
  const forced = user.must_change_password;

  return (
    <div className="section reading" style={{ maxWidth: 460 }}>
      <div className="card pad">
        <h2 style={{ fontSize: "var(--fs-h2)", fontWeight: 680, marginBottom: 6 }}>
          {forced ? "Set your password" : "Change your password"}
        </h2>

        {forced ? (
          <p className="note" style={{ marginBottom: 18 }}>
            Your account was created with a password someone else chose. Pick your
            own before you carry on — until you do, whoever set it up could sign
            in as you.
          </p>
        ) : (
          <p className="note" style={{ marginBottom: 18 }}>
            Signed in as {user.email}.
          </p>
        )}

        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}

        <form action={changePasswordAction}>
          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="password">New password</label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              autoFocus
            />
            <div className="note" style={{ marginTop: 6 }}>
              At least 10 characters.
            </div>
          </div>

          <div className="field" style={{ marginBottom: 18 }}>
            <label htmlFor="confirm">Confirm new password</label>
            <input
              className="input"
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
            />
          </div>

          <button className="btn btn-primary" type="submit" style={{ width: "100%" }}>
            {forced ? "Set password and continue" : "Change password"}
          </button>
        </form>

        {forced && (
          <p className="note" style={{ marginTop: 14 }}>
            There is no way past this screen — every other page will send you back
            here until the password is yours.
          </p>
        )}
      </div>
    </div>
  );
}
