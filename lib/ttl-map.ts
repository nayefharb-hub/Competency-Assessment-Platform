/**
 * A tiny TTL + LRU map for request-adjacent memoization.
 *
 * Exists for exactly one pattern (docs/eng-plan-save-latency.md): a server
 * action and the render of its redirect target run as two separate passes of
 * ONE request, and React's `cache()` does not span them — so work the action
 * just did is repeated ~200ms later. A short-TTL memo bridges that gap.
 *
 * This is per-user state at module scope, which the Fluid Compute rule
 * (docs/deploy.md) forbids by default. The argued exception lives where the
 * maps are declared; the properties that make it safe live here:
 * - a served entry is never older than `ttlMs`, because expiry is checked on
 *   READ. Note what that does NOT mean: an entry nobody asks for again is not
 *   erased on a timer, so it stays resident until evicted. On a 9-user
 *   deployment a Fluid instance may never reach the cap, so assume the last
 *   few tokens it saw are still in its memory;
 * - the map is capped: inserting past `max` evicts the OLDEST INSERTED entry.
 *   This is FIFO, not LRU — `get` does not refresh recency. Fine for a 2s
 *   window, and worth knowing before reusing this class somewhere it matters;
 * - keys are never enumerated or logged by this class.
 */
export class TTLMap<K, V> {
  private map = new Map<K, { value: V; expires: number }>();
  private ttlMs: number;
  private max: number;

  // Plain assignments rather than TS parameter properties, so the class stays
  // erasable-syntax-only and `node --experimental-strip-types` can run the
  // unit test against this file directly (scripts/ttl-map.test.mjs).
  constructor(ttlMs: number, max: number) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: K, value: V): void {
    // Delete-then-set keeps insertion order = recency order, which is what
    // makes the eviction below "oldest first" rather than arbitrary.
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}
