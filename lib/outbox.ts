"use client";

/**
 * The outbox — committed answers waiting to reach the server.
 *
 * WHY THIS EXISTS, and why it is app-level rather than a widget on the
 * assess page (docs/eng-plan-save-ux.md):
 *
 * Clicking "Next control" is the commit. Navigation must not wait for the
 * write, so the write outlives the page that started it: the PM may already
 * be two controls further on, or looking at Results, when a save fails. A
 * queue that lived in the assess page would be destroyed by the navigation
 * that is the whole point of the design.
 *
 *   pick a level ──► local only, nothing sent, change your mind freely
 *   click Next   ──► enqueue + navigate immediately
 *                       │
 *                       ├─ ok    → entry dropped, quietly
 *                       └─ fail  → stays queued, retried 2·4·8·16·30s…
 *                                  banner shows the count, anywhere in the app
 *
 * Three things flush the queue ahead of its countdown: the browser coming
 * back online, any new commit (each Next retries everything), and the PM
 * pressing "Retry now".
 *
 * There is no give-up state. These are answers the PM confirmed; discarding
 * them silently is never the right move. The queue is mirrored to
 * localStorage so a refresh, a crash, or a closed tab mid-outage does not
 * lose them either — the mirror is a failure buffer, NOT an offline mode.
 */

export interface OutboxEntry {
  /** Control code, e.g. "4.3.1.1". Also the queue key: last write wins. */
  control: string;
  level: number;
  evidence: string | null;
  /** Attempts so far — drives the backoff, and survives the mirror. */
  tries: number;
}

export interface OutboxState {
  pending: OutboxEntry[];
  /** True while a flush is in flight, so the banner can say "retrying…". */
  flushing: boolean;
  /** Epoch ms of the next scheduled attempt, or null when idle/flushing. */
  nextAttemptAt: number | null;
}

/** 2s, 4s, 8s, 16s, then every 30s — indefinitely. */
function backoffMs(tries: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, tries - 1), 30_000);
}

type Saver = (e: OutboxEntry) => Promise<{ ok: boolean }>;

const KEY_PREFIX = "cap.outbox.";

let key = "";                       // set by configure(): per user + assessment
let queue: OutboxEntry[] = [];
let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextAttemptAt: number | null = null;
let save: Saver | null = null;
const listeners = new Set<() => void>();

/* ------------------------------------------------------------ subscribe */

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let snapshot: OutboxState = { pending: [], flushing: false, nextAttemptAt: null };

export function getSnapshot(): OutboxState {
  return snapshot;
}

/** Server render has no queue; useSyncExternalStore needs a stable value. */
const SERVER_SNAPSHOT: OutboxState = { pending: [], flushing: false, nextAttemptAt: null };
export function getServerSnapshot(): OutboxState {
  return SERVER_SNAPSHOT;
}

function publish() {
  // A NEW object every time: useSyncExternalStore compares by identity, and a
  // mutated-in-place snapshot would never re-render the banner.
  snapshot = { pending: [...queue], flushing, nextAttemptAt };
  for (const fn of listeners) fn();
}

/* ------------------------------------------------------------- the mirror */

function persist() {
  if (!key) return;
  try {
    if (queue.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(queue));
  } catch {
    // Private mode, quota, storage disabled. The in-memory queue still works;
    // only the survives-a-refresh guarantee is lost, and saying so in the
    // console beats pretending it persisted.
    console.warn("[outbox] could not mirror to localStorage");
  }
}

/**
 * Bind the outbox to this user and adopt anything a previous visit left
 * behind.
 *
 * Called from the LAYOUT, not the assessment page — a full page load anywhere
 * in the app destroys JS memory, so if only the assessment page restored the
 * mirror, a PM who reloaded on Results would see no warning and the queue
 * would sit there unsent until they wandered back. Measured: the e2e outage
 * test caught exactly that.
 *
 * Keyed by user alone. The assessment is not part of the key because the
 * server resolves it from the session at commit time — the entry says which
 * CONTROL, never which assessment, so a queued answer cannot be aimed at
 * someone else's record. The user id is the boundary that matters: a shared
 * machine must never flush one PM's answers under another's session.
 */
export function configure(userId: string, saver: Saver) {
  save = saver;
  const next = `${KEY_PREFIX}${userId}`;
  if (next === key) return;          // already bound; keep the live queue
  key = next;
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    queue = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    queue = [];
  }
  publish();
  if (queue.length > 0) schedule(0);  // a previous session left work: try now
}

function isEntry(v: unknown): v is OutboxEntry {
  const e = v as OutboxEntry;
  return !!e && typeof e.control === "string" && typeof e.level === "number";
}

/* --------------------------------------------------------------- commits */

/**
 * Commit one control. Called by Next — it returns immediately so navigation
 * is never blocked, and a new commit also retries everything already queued.
 */
export function commit(entry: Omit<OutboxEntry, "tries">) {
  queue = [...queue.filter((e) => e.control !== entry.control), { ...entry, tries: 0 }];
  persist();
  publish();
  schedule(0);
}

export function retryNow() {
  schedule(0);
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  nextAttemptAt = queue.length > 0 ? Date.now() + delay : null;
  timer = setTimeout(flush, delay);
  publish();
}

async function flush() {
  if (flushing || queue.length === 0 || !save) return;
  flushing = true;
  nextAttemptAt = null;
  publish();

  // Snapshot the queue: commits made DURING the flush must not be dropped by
  // the bookkeeping below, so removal is by control code, never by index.
  const attempting = [...queue];
  let failed = false;

  for (const entry of attempting) {
    let ok = false;
    try {
      ok = (await save(entry)).ok;
    } catch {
      ok = false;
    }
    if (ok) {
      queue = queue.filter((e) => e !== entry);
    } else {
      failed = true;
      entry.tries += 1;
    }
    persist();
    publish();
  }

  flushing = false;
  if (queue.length > 0) {
    const tries = Math.max(...queue.map((e) => e.tries));
    schedule(failed ? backoffMs(tries) : 0);
  } else {
    nextAttemptAt = null;
    if (timer) clearTimeout(timer);
    timer = null;
    publish();
  }
}

/* --------------------------------------------------------------- browser */

let wired = false;

/** Flush the moment the browser says the network is back — not 30s later. */
export function wireBrowserEvents() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("online", () => {
    if (queue.length > 0) schedule(0);
  });
  // A tab going away is the last chance to try; the mirror covers the rest.
  window.addEventListener("pagehide", () => {
    if (queue.length > 0) persist();
  });
}
