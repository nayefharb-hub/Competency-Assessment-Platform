/**
 * Proxy (formerly middleware). Refreshes the Supabase session cookie and turns
 * away anyone without one.
 *
 * This is the COARSE gate only — it proves a session cookie exists, nothing
 * more. The real allowlist check (does this account have an app_user row?) and
 * every role check happen server-side in lib/auth.ts. Since the save-latency
 * work that file verifies the token's SIGNATURE locally (getClaims, ES256)
 * rather than asking Supabase per request — so a forged or expired token is
 * still refused there, but a token revoked by signing out elsewhere stays
 * valid until it expires. That trade, and the shortened token lifetime that
 * bounds it, are recorded in docs/deploy.md. Nothing is trusted on the
 * strength of THIS file either way.
 *
 * PERFORMANCE (why it no longer validates here itself): this runs on EVERY
 * request, and `getUser()` is a network round trip to Supabase Auth. The page
 * that follows immediately makes the same call again, so the app was paying for
 * two identical validations per navigation — part of the ~18 Supabase round
 * trips measured for one cold render. Checking that a session cookie is present
 * is enough for a redirect-if-signed-out gate; a forged or expired cookie gets
 * no further than lib/auth.ts, which is where it was always going to be caught.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SESSION_COOKIE } from "@/lib/supabase/cookies";

const PUBLIC_PATHS = ["/login", "/logout"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) {
            // SESSION_COOKIE last: it must beat the library's httpOnly: false.
            response.cookies.set(name, value, { ...options, ...SESSION_COOKIE });
          }
        },
      },
    },
  );

  // getSession reads and refreshes from the cookie WITHOUT a network call to
  // validate it. That is the whole point here — see the note above.
  const { data } = await supabase.auth.getSession();
  const path = request.nextUrl.pathname;

  // Deliberately no redirect FROM /login when signed in: an authenticated
  // account that is not on the allowlist needs to be able to reach /login.
  if (!data.session && !PUBLIC_PATHS.includes(path)) {
    const target = new URL("/login", request.url);
    if (path !== "/") target.searchParams.set("next", path + request.nextUrl.search);
    return NextResponse.redirect(target);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|woff2)$).*)"],
};
