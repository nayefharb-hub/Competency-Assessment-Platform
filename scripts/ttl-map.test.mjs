/**
 * Unit test for lib/ttl-map.ts — the one piece of module-scope per-user state
 * the Fluid audit allows (see docs/deploy.md). Run with:
 *
 *   npm run test:unit
 *
 * Plain node:test against the TS source via --experimental-strip-types; no
 * framework, no build step, no database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TTLMap } from "../lib/ttl-map.ts";

test("stores and returns within TTL", () => {
  const m = new TTLMap(1_000, 10);
  m.set("a", 1);
  assert.equal(m.get("a"), 1);
});

test("an expired entry is gone, not stale", async () => {
  const m = new TTLMap(30, 10);
  m.set("a", 1);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(m.get("a"), undefined);
});

test("delete removes immediately — the signOut purge", () => {
  const m = new TTLMap(1_000, 10);
  m.set("token", "viewer");
  m.delete("token");
  assert.equal(m.get("token"), undefined);
});

test("cap evicts the oldest entry, not an arbitrary one", () => {
  const m = new TTLMap(1_000, 3);
  m.set("a", 1);
  m.set("b", 2);
  m.set("c", 3);
  m.set("d", 4); // over cap: "a" goes
  assert.equal(m.get("a"), undefined);
  assert.equal(m.get("b"), 2);
  assert.equal(m.get("d"), 4);
});

test("re-setting a key refreshes its recency, so it survives eviction", () => {
  const m = new TTLMap(1_000, 3);
  m.set("a", 1);
  m.set("b", 2);
  m.set("c", 3);
  m.set("a", 10); // touch "a" — now "b" is oldest
  m.set("d", 4);
  assert.equal(m.get("b"), undefined);
  assert.equal(m.get("a"), 10);
});
