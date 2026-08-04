/**
 * Server-only Supabase clients.
 *
 * `import "server-only"` makes this a BUILD ERROR if any client component ever
 * pulls it in — the browser must never hold a table-capable key. The service
 * role key bypasses RLS entirely, which is deliberate: access control for this
 * app lives in the server data layer (see supabase/migrations/0002_rls.sql).
 */
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export function supabaseUrl(): string {
  return process.env.SUPABASE_URL ?? required("NEXT_PUBLIC_SUPABASE_URL");
}

export function supabaseAnonKey(): string {
  return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

/**
 * Times every Supabase request and logs it.
 *
 * Vercel reports how long a render took, but not what it spent the time ON.
 * Two rounds of this investigation were spent inferring that from call counts
 * and getting it wrong — the round-trip count came down 18 → 4 and the render
 * stayed slow, which only a per-call timing could have shown early.
 *
 * One line per query, roughly four per page. Compare their sum against the
 * `durationMs` Vercel reports: if the sum is small and the duration is large,
 * the time is NOT in the database and looking there is a waste.
 *
 * Set PERF_LOG=0 to silence it once the pilot is settled.
 */
function timedFetch(tag: string): typeof fetch {
  if (process.env.PERF_LOG === "0") return fetch;
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const started = Date.now();
    try {
      return await fetch(input, init);
    } finally {
      const url = typeof input === "string" ? input
        : input instanceof URL ? input.href : (input as Request).url;
      const path = url.split(".supabase.co")[1]?.split("?")[0] ?? url;
      console.log(`[supabase ${tag}] ${Date.now() - started}ms ${path}`);
    }
  };
}

export const timedSupabaseFetch = timedFetch;

let serviceClient: SupabaseClient | null = null;

/**
 * Service-role client — FULL database access, bypasses RLS.
 * Only ever call this from server code (server components, server actions,
 * route handlers, scripts).
 */
export function db(): SupabaseClient {
  if (!serviceClient) {
    serviceClient = createClient(supabaseUrl(), required("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "public" },
      global: { fetch: timedFetch("db") },
    });
  }
  return serviceClient;
}

/** Throws with table + PostgREST detail attached, so failures aren't silent. */
export function unwrap<T>(
  what: string,
  result: { data: T | null; error: { message: string; details?: string | null } | null },
): T {
  if (result.error) {
    throw new Error(`Supabase ${what} failed: ${result.error.message}${
      result.error.details ? ` (${result.error.details})` : ""
    }`);
  }
  if (result.data === null) {
    throw new Error(`Supabase ${what} returned no data`);
  }
  return result.data;
}
