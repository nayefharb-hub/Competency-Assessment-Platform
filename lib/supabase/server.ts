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
