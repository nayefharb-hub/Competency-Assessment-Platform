import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/lib/auth";
import { SESSION_START_COOKIE } from "@/lib/supabase/cookies";

/** Clears the session. `?denied=1` means the account is not on the allowlist. */
export async function GET(request: NextRequest) {
  // CSRF (/cso LOW-1, 2026-08-12): logout is state-changing, and sameSite=lax
  // sends the session cookie on a top-level cross-site GET — so a foreign
  // `<img src=/logout>` or link could sign a user out (a nuisance: they lose
  // their place, no data is read or changed). Same-origin triggers — our own
  // sign-out link and the internal 302s from requireUser — send
  // `sec-fetch-site: same-origin`; a directly typed URL sends `none`. Refuse
  // anything explicitly cross-site, and leave every legitimate path working.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.redirect(new URL("/", request.url));
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
