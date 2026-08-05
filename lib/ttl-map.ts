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
 * - every entry expires after `ttlMs` (checked on read, no timers);
 * - the map is capped: inserting past `max` evicts the oldest entry;
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
