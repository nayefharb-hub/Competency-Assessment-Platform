import "server-only";

/**
 * Phase timing for a single render.
 *
 * Per-call Supabase timing told us how long each QUERY took. It could not tell
 * us where the rest of the time went, and on this app the rest is most of it: a
 * warm Frankfurt render measured 1547ms with the database in the same city.
 *
 * So: time the phases, not just the queries. If the phases sum to 80ms inside a
 * 1500ms render, the work is not in our code at all and the next place to look
 * is the platform — bundle size, module init, the data cache.
 *
 * PERF_LOG=0 silences it.
 */
export async function phase<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (process.env.PERF_LOG === "0") return fn();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[phase] ${String(Date.now() - started).padStart(5)}ms ${label}`);
  }
}
