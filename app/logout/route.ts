import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/lib/auth";
import { SESSION_START_COOKIE } from "@/lib/supabase/cookies";

/** Clears the session. `?denied=1` means the account is not on the allowlist. */
export async function GET(request: NextRequest) {
  // CSRF (/cso LOW-1, 2026-08-12): logout is state-changing, and sameSite=lax
  // sends the session cookie on a top-level cross-site navigation (a link or
  // window.open to /logout — NOT a subresource like <img>, which lax excludes),
  // so a foreign page could sign a user out (a nuisance: they lose their place,
  // no data read or changed). Accept ONLY same-origin (our sign-out link and the
  // internal 302s from requireUser) and `none` (a typed URL / bookmark). Reject
  // `same-site` too, so an untrusted sibling subdomain on a future custom apex
  // (e.g. bank.example) cannot forge it.
  //
  // Redirect a refused request to /login, NOT a protected route: Sec-Fetch-Site
  // reflects the ORIGINAL initiator across the whole redirect chain, so an
  // uninvited account arriving from an EXTERNAL link taints its own internal
  // `/logout?denied` redirect as cross-site. Bouncing that to `/` (protected)
  // would loop forever and never clear the session; /login is public and ends
  // it. Carry `denied` so the allowlist-refusal banner still shows. A normal
  // signed-in user hit by CSRF lands on /login and is redirected straight back
  // into the app (still signed in) — the nuisance is neutralised either way.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    const back = new URL("/login", request.url);
    if (request.nextUrl.searchParams.get("denied")) back.searchParams.set("denied", "1");
    return NextResponse.redirect(back);
  }
  await signOut();
  const target = new URL("/login", request.url);
  if (request.nextUrl.searchParams.get("denied")) target.searchParams.set("denied", "1");
  const response = NextResponse.redirect(target);
  // Where someone had got to is theirs, not the next person's. Left behind,
  // it resumes the NEXT sign-in on this machine at the previous PM's control
  // — which says how far they had got and which competence they were on.
  response.cookies.delete("cap.last");
  response.cookies.delete(SESSION_START_COOKIE);
  return response;
}

export async function POST(request: NextRequest) {
  return GET(request);
}
