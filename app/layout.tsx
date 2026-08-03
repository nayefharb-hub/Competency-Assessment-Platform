import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Competency Assessment — KIB PMO",
  description: "Assess project managers against the IPMA ICB4 framework.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
            <nav className="nav" aria-label="Main">
              <Link href="/assess">Self-assessment</Link>
              <Link href="/results">Results</Link>
              <Link href="/review">Review</Link>
              <Link href="/admin">Framework</Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
