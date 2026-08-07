import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { ASSESS_HUB, safeNext } from "@/lib/routes";
import SignInForm from "./form";

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
  searchParams: Promise<{ denied?: string; next?: string }>;
}) {
  const { denied, next } = await searchParams;

  /*
   * Already signed in? Go where they were headed (N22).
   *
   * Without this the page renders a sign-in form INSIDE the signed-in chrome —
   * the owner read that as "I am logged out but the nav is still showing" and
   * reported it as a session leak. It was the opposite: the session was fine
   * and the form was the thing that should not have been there.
   *
   * `denied=1` is deliberately exempt. That arrives from /logout after an
   * allowlist refusal, and its banner is the only explanation the person gets;
   * redirecting on it would bounce them to a page they cannot use and swallow
   * the reason. It is reachable while signed out, so this never loops.
   *
   * Same in-app-path guard as the sign-in action, and now literally the same
   * function: both copies of the old inline regex admitted "/\t/evil.com",
   * which resolves cross-origin. See safeNext in lib/routes.ts.
   *
   * Role-aware for the same reason the action is (D32): an assessee who is
   * already signed in and revisits /login is in exactly the position a fresh
   * sign-in puts them, so they land in the same place. Without this the two
   * doors disagreed, which is the defect this whole change exists to remove.
   */
  if (!denied) {
    const who = await currentUser();
    if (who) {
      const safe = safeNext(next);
      redirect(safe === "/" && who.role === "assessee" ? ASSESS_HUB : safe);
    }
  }

  return (
    <div className="section" style={{ maxWidth: 420, margin: "48px auto 0" }}>
      <div className="card pad">
        <h2 style={{ fontSize: "var(--fs-h2)", fontWeight: 680, marginBottom: 4 }}>Sign in</h2>
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
        <SignInForm next={next} />
      </div>
    </div>
  );
}
