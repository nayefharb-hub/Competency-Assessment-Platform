import type { Metadata } from "next";
import Link from "@/app/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { currentUser } from "@/lib/auth";
import { ASSESS_HUB } from "@/lib/routes";
import { currentTheme } from "./theme-server";
import ThemeToggle from "./theme-toggle";
import OutboxBanner from "./outbox-banner";
import OfflineBanner from "./offline-banner";
import SignOutLink from "./sign-out-link";
import NavProgress from "./nav-progress";
import "./globals.css";

export const metadata: Metadata = {
  title: "Competency Assessment — KIB PMO",
  description: "Assess project managers against the IPMA ICB4 framework.",
};

const ROLE_LABEL: Record<string, string> = {
  assessee: "Project manager",
  assessor: "Assessor",
  admin: "Administrator",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, theme] = await Promise.all([currentUser(), currentTheme()]);
  const isAssessor = user?.role === "assessor" || user?.role === "admin";

  return (
    // Geist is self-hosted through next/font — no runtime CDN, per DESIGN.md.
    // General Sans (the display face) is still outstanding; see DESIGN.md.
    // data-theme is ALWAYS present, including "system". Rendering undefined
    // for system would mean switching back to Auto has to *remove* an attribute
    // from <html>, and React does not reliably do that across a server-action
    // refresh — measured: the page stayed on the old theme until a full reload.
    // "system" matches neither themed selector, so prefers-color-scheme governs,
    // which is the same outcome without asking React to remove anything.
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-theme={theme}
    >
      <body>
        {/* Fixed to the viewport top, above everything — the in-app stand-in for
            the browser's tab spinner, which client-side navigation never fires.
            Outside the `user &&` gate so it also covers login/change-password. */}
        <NavProgress />
        <div className="shell">
          <header className="topbar">
            <div className="brand">
              <div className="logo" aria-hidden="true">CA</div>
              <div>
                <h1>Competency Assessment</h1>
                <p>KIB PMO · ICB4 Project Manager framework</p>
              </div>
            </div>
            {user && (
              <nav className="nav" aria-label="Main">
                <Link href={ASSESS_HUB}>Self-assessment</Link>
                <Link href="/results">Results</Link>
                {/* Shown to everyone, on purpose (D21). This is where a PM
                    reads their own pace, and a measurement of someone's
                    working that they cannot look at is a trap rather than an
                    instrument. The route resolves an assessee's assessment
                    from the session, so the shared link is not a shared view. */}
                <Link href="/analysis">Analysis</Link>
                {isAssessor && <Link href="/review">Review</Link>}
                {user.role === "admin" && <Link href="/admin/people">People</Link>}
                {/* The LIST, not the editor. Landing on /admin put an admin
                    inside one control with no view of the framework (N44). */}
                {user.role === "admin" && <Link href="/admin/controls">Framework</Link>}
              </nav>
            )}
          </header>

          {user && (
            <div className="whoami">
              <span>
                <b>{user.full_name}</b>
                <span className="muted"> · {ROLE_LABEL[user.role] ?? user.role}</span>
              </span>
              <span className="whoami-right">
                <ThemeToggle current={theme} />
                <SignOutLink />
              </span>
            </div>
          )}

          {/* Above <main> and outside every route: a failed save has to stay
              visible after the PM navigates away from the control that made
              it (docs/eng-plan-save-ux.md). Renders nothing when the queue is
              empty, which is nearly always. */}
          {user && <OfflineBanner />}
          {user && <OutboxBanner userId={user.id} />}

          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
