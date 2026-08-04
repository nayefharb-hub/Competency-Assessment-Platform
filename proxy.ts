/**
 * Proxy (formerly middleware). Refreshes the Supabase session cookie on every request and turns away anyone
 * without one. This is the coarse gate only — it proves a valid session exists,
 * nothing more. The real allowlist check (does this account have an app_user
 * row?) and every role check happen server-side in lib/auth.ts, because only
 * the service-role client can read app_user.
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

  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;

  // Deliberately no redirect FROM /login when signed in: an authenticated
  // account that is not on the allowlist needs to be able to reach /login.
  if (!data.user && !PUBLIC_PATHS.includes(path)) {
    const target = new URL("/login", request.url);
    if (path !== "/") target.searchParams.set("next", path + request.nextUrl.search);
    return NextResponse.redirect(target);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|woff2)$).*)"],
};
