import type { Metadata } from "next";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { currentUser } from "@/lib/auth";
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
  const user = await currentUser();
  const isAssessor = user?.role === "assessor" || user?.role === "admin";

  return (
    // Geist is self-hosted through next/font — no runtime CDN, per DESIGN.md.
    // General Sans (the display face) is still outstanding; see DESIGN.md.
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
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
                <Link href="/assess">Self-assessment</Link>
                <Link href="/results">Results</Link>
                {isAssessor && <Link href="/review">Review</Link>}
                {user.role === "admin" && <Link href="/admin/people">People</Link>}
                {user.role === "admin" && <Link href="/admin">Framework</Link>}
              </nav>
            )}
          </header>

          {user && (
            <div className="whoami">
              <span>
                <b>{user.full_name}</b>
                <span className="muted"> · {ROLE_LABEL[user.role] ?? user.role}</span>
              </span>
              <a href="/logout">Sign out</a>
            </div>
          )}

          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
