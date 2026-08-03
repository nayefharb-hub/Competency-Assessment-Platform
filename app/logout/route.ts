import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/lib/auth";

/** Clears the session. `?denied=1` means the account is not on the allowlist. */
export async function GET(request: NextRequest) {
  await signOut();
  const target = new URL("/login", request.url);
  if (request.nextUrl.searchParams.get("denied")) target.searchParams.set("denied", "1");
  return NextResponse.redirect(target);
}

export async function POST(request: NextRequest) {
  return GET(request);
}
