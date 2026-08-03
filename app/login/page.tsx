import { signIn } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Invite-only sign-in.
 *
 * Accounts are created by an admin (scripts/invite.mjs); there is no public
 * signup. The error message is deliberately identical for "wrong password",
 * "no such account" and "not invited" — telling an outsider which of the three
 * it is would leak the pilot's staff list.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; denied?: string; next?: string }>;
}) {
  const { error, denied, next } = await searchParams;

  return (
    <div className="section" style={{ maxWidth: 420, margin: "48px auto 0" }}>
      <div className="card pad">
        <h2 style={{ fontSize: 20, fontWeight: 680, marginBottom: 4 }}>Sign in</h2>
        <p className="note" style={{ marginBottom: 18 }}>
          KIB PMO competency assessment. Access is by invitation — if you need an
          account, ask the Head of PMO.
        </p>

        {denied && (
          <div className="banner banner-warn" role="status">
            That account is not on the assessment allowlist. Ask the Head of PMO to
            invite you.
          </div>
        )}
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}

        <form action={signIn}>
          <input type="hidden" name="next" value={next ?? "/"} />
          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="email">Work email</label>
            <input
              className="input"
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              placeholder="you@kib.com.kw"
            />
          </div>
          <div className="field" style={{ marginBottom: 18 }}>
            <label htmlFor="password">Password</label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <button className="btn btn-primary" type="submit" style={{ width: "100%" }}>
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
