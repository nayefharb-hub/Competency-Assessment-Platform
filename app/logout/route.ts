import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/lib/auth";

/** Clears the session. `?denied=1` means the account is not on the allowlist. */
export async function GET(request: NextRequest) {
  await signOut();
  const target = new URL("/login", request.url);
  if (request.nextUrl.searchParams.get("denied")) target.searchParams.set("denied", "1");
  const response = NextResponse.redirect(target);
  // Where someone had got to is theirs, not the next person's. Left behind,
  // it resumes the NEXT sign-in on this machine at the previous PM's control
  // — which says how far they had got and which competence they were on.
  response.cookies.delete("cap.last");
  return response;
}

export async function POST(request: NextRequest) {
  return GET(request);
}
