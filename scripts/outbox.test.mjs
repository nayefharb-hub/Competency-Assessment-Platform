/**
 * Unit tests for the outbox's memory of what this browser confirmed.
 *
 * WHY THESE EXIST. The e2e suite drives the whole app and is the only thing
 * that can prove the milestone rises on the walked path — but three of the
 * paths that make `answered` safe cannot be reached from a browser test at all
 * without a second account, a second assessment, or a server that refuses a
 * write on identity grounds. A review pass found every one of them untested:
 * drop the `answered.clear()` in configure(), or the delete on `reject`, or the
 * assessment scoping, and the 342-check e2e suite stays green.
 *
 * lib/outbox.ts is a client module: it touches localStorage and `window`. The
 * shims below are the smallest thing that lets it load under node:test — a Map
 * behind the localStorage interface and a window with no listeners, which is
 * exactly what the module needs and nothing it does not.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

/* --- the browser, in twenty lines ---------------------------------------- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { commit, configure, answeredLevel, pendingFor } = await import("../lib/outbox.ts");

/** A saver whose verdict the test controls. */
function saver(verdict = { ok: true }) {
  const calls = [];
  const fn = async (entry) => { calls.push(entry); return verdict; };
  fn.calls = calls;
  return fn;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

/*
 * A FRESH USER PER TEST, because `configure` deliberately early-returns when
 * the user has not changed ("already bound; keep the live queue") — so binding
 * the same id twice does NOT reset the queue, and a test that leaves a failing
 * entry would hand it to the next one. That is the module being right and the
 * first draft of this file being wrong: it reused "user-1" everywhere and the
 * mirror test then found two entries where it expected one.
 */
let uids = 0;
const uid = () => `user-${uids++}`;

/*
 * AND THEN LEAVE, DELIBERATELY.
 *
 * There is no give-up state in this queue by design — a failed write is retried
 * 2·4·8·16·30s indefinitely, because these are answers a PM confirmed and
 * discarding them silently is never right. That means a test which leaves a
 * failing entry also leaves an armed timer, and node:test will not exit while
 * one is pending: the run hangs for as long as the backoff, which is forever.
 * The module owns those timers and exposes no way to cancel them, which is the
 * correct API for the app and an awkward one for a test file. So: bind a fresh
 * user (restoring an empty queue from that user's mirror, which is the module's
 * own way of dropping work) and then end the process once the assertions have
 * all run. Every test above has already completed by the time this fires.
 */
after(() => {
  configure("drain", saver({ ok: true }));
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const A = "assessment-aaa";
const B = "assessment-bbb";

test("an acknowledged answer is still remembered — the whole point", async () => {
  store.clear();
  configure(uid(), saver({ ok: true }));
  commit({ control: "4.3.1.1", level: 3, evidence: null }, A);
  await settle();
  assert.equal(pendingFor("4.3.1.1"), undefined, "the queue drops it once sent");
  assert.equal(answeredLevel(A, "4.3.1.1"), 3, "but the client still knows it was answered");
});

test("a different person clears the memory", async () => {
  store.clear();
  configure(uid(), saver());
  commit({ control: "4.3.1.1", level: 4, evidence: null }, A);
  await settle();
  assert.equal(answeredLevel(A, "4.3.1.1"), 4);

  configure(uid(), saver());
  assert.equal(answeredLevel(A, "4.3.1.1"), null,
    "one PM's answers must never decide whether another's competency looks complete");
});

test("re-binding the SAME person keeps the memory", async () => {
  store.clear();
  const same = uid();
  configure(same, saver());
  commit({ control: "4.3.1.2", level: 2, evidence: null }, A);
  await settle();
  configure(same, saver());          // the layout effect re-running
  assert.equal(answeredLevel(A, "4.3.1.2"), 2,
    "clearing here would defeat the fix on every re-render");
});

test("the memory is scoped to the assessment", async () => {
  store.clear();
  configure(uid(), saver());
  commit({ control: "4.3.1.3", level: 5, evidence: null }, A);
  await settle();
  assert.equal(answeredLevel(A, "4.3.1.3"), 5);
  assert.equal(answeredLevel(B, "4.3.1.3"), null,
    "a re-assignment or a new cycle must not inherit yesterday's answers");
});

test("a refused write is forgotten, in every scope", async () => {
  store.clear();
  configure(uid(), saver({ ok: false, reject: true }));
  commit({ control: "4.3.1.4", level: 3, evidence: null }, A);
  await settle();
  assert.equal(answeredLevel(A, "4.3.1.4"), null,
    "the record will never hold it, so the screen must not count it");
  assert.equal(pendingFor("4.3.1.4"), undefined, "and it is not retried forever");
});

test("a failed (not refused) write keeps both the queue entry and the memory", async () => {
  store.clear();
  configure(uid(), saver({ ok: false }));
  commit({ control: "4.3.1.5", level: 1, evidence: null }, A);
  await settle();
  assert.ok(pendingFor("4.3.1.5"), "still queued for retry");
  assert.equal(answeredLevel(A, "4.3.1.5"), 1,
    "the PM answered it; a network failure does not un-answer it");
});

test("the mirror survives a reload, which is what the queue is for", async () => {
  store.clear();
  configure(uid(), saver({ ok: false }));
  commit({ control: "4.3.2.1", level: 4, evidence: null }, A);
  await settle();
  const key = Object.keys(Object.fromEntries(store)).find((k) => k.startsWith("cap.outbox."));
  const mirrored = JSON.parse(store.get(key) ?? "[]");
  assert.equal(mirrored.length, 1, "an unsent answer is written to localStorage");
  assert.equal(mirrored[0].control, "4.3.2.1");
  assert.equal(mirrored[0].level, 4);
});
