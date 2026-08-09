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
  /**
   * When this control first entered the queue. The banner needs it because
   * `tries` only rises AFTER an attempt returns, and an attempt against a
   * hung server can take minutes to do that — during which confirmed answers
   * would be sitting unsent with nothing on screen saying so.
   */
  queuedAt: number;
  /**
   * WHO confirmed this answer.
   *
   * Not decoration, and not the same thing as the storage key. A server
   * action posts with whatever session cookie the BROWSER currently holds,
   * which is not necessarily the person who queued the entry: leave a tab
   * open with a failed save, have a colleague sign in on the same machine,
   * and the retry timer in the stale tab would write one PM's answer into
   * the other's assessment. Carrying the id lets the server refuse that.
   */
  userId: string;
  /**
   * Milliseconds this control was on screen and VISIBLE before Next (D28).
   *
   * Optional, and it has to stay optional: entries mirrored to localStorage by
   * the build before this one have no such field, and rejecting them would
   * silently discard confirmed answers on the first deploy — the one failure
   * this queue exists to prevent. Absent means "not measured", which is a real
   * state the analysis reports rather than guesses at.
   */
  dwellMs?: number | null;
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

/**
 * `ok` drops the entry. `retry` keeps it (network blips, database trouble).
 * `reject` drops it WITHOUT writing — the server refused on identity grounds,
 * and retrying could only make that worse.
 */
type Saver = (e: OutboxEntry) => Promise<{ ok: boolean; reject?: boolean }>;

const KEY_PREFIX = "cap.outbox.";

let key = "";                       // set by configure(): per user
let boundUserId = "";               // who this browser is signed in as, right now
let queue: OutboxEntry[] = [];
let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextAttemptAt: number | null = null;
let save: Saver | null = null;
let mirrorHealthy = true;
const listeners = new Set<() => void>();

/**
 * EVERY ANSWER THIS BROWSER HAS CONFIRMED THIS SESSION — including the ones
 * already acknowledged and dropped from the queue above.
 *
 * N33, and it is the reason `pendingFor` alone was never enough. The commit
 * POST and the navigation GET leave together (D9), so the server render of the
 * NEXT control is taken before the write lands — measured, every time, not
 * occasionally. The queue then drops the entry the moment the server says ok.
 * Between those two moments the answer exists nowhere the client can see it:
 * the server render predates it and the queue has forgotten it. At the last
 * control of a competency that made `ceComplete` false, so the button read
 * "Next control" and the milestone never rose — on the walked path, which is
 * the only path a PM actually takes.
 *
 * THE INVARIANT, stated exactly, because the first draft of this comment said
 * "it only grows" and the same commit added two ways to remove an entry.
 * ACKNOWLEDGEMENT never removes anything — that is the whole difference from
 * the queue. A user change (`configure`) and a server refusal (`reject`) do,
 * and both mean the answer is no longer this screen's to count.
 *
 * KEYED BY ASSESSMENT, not by control alone. A control code is not unique
 * across time: `lib/db/assessment.ts` allows an archived assessment to be
 * replaced by a fresh assignment, and a cycle rolls over. Both can happen while
 * a tab stays open, and `configure` would not fire — same person, same storage
 * key. Keyed by control alone, the morning's answers would declare an empty new
 * record complete and hand the PM to a Submit the server refuses, which is the
 * exact defect class the previous review pass found. Scoping by assessment also
 * means a tab whose session moved to another PM can never read the first PM's
 * answers, because the id in the render no longer matches the one they were
 * stored under.
 *
 * IN MEMORY, NOT MIRRORED. Answers that have NOT reached the server are the
 * QUEUE's job, and the queue is mirrored; `effectiveLevel` asks both, so a
 * reload during an outage still sees them (that chain is load-bearing — see
 * app/assess/score-panel.tsx).
 */
const answered = new Map<string, number>();
const answeredKey = (scope: string, control: string) => `${scope}|${control}`;

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
    mirrorHealthy = false;
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
  boundUserId = userId;
  const next = `${KEY_PREFIX}${userId}`;
  if (next === key) return;          // already bound; keep the live queue
  key = next;
  // A different person is signed in now. What the PREVIOUS one answered is not
  // this one's assessment, and letting it decide whether a competency looks
  // complete would show one PM their colleague's progress.
  //
  // DEFENCE IN DEPTH, NOT THE PRIMARY GUARD, and worth being honest about:
  // every real sign-out is a hard navigation, so a new person almost always
  // starts with an empty module scope and this clear is a no-op. The case it
  // cannot reach is a tab left open while the session changes underneath it —
  // `configure` is not called again there, because the root layout is not
  // re-rendered by a client-side navigation. That case is covered instead by
  // keying `answered` on the assessment id, which comes from the render.
  answered.clear();
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

/**
 * Anything read back from localStorage is untrusted input: an older build, a
 * truncated write, or someone editing devtools. A missing `tries` in
 * particular turns `tries + 1` into NaN, which makes the backoff NaN, which
 * `setTimeout` coerces to 0 — a tight retry loop with the banner permanently
 * hidden, because NaN > 0 is false.
 */
function isEntry(v: unknown): v is OutboxEntry {
  const e = v as OutboxEntry;
  return !!e
    && typeof e.control === "string"
    && Number.isInteger(e.level)
    && typeof e.userId === "string"
    && Number.isFinite(e.tries)
    && Number.isFinite(e.queuedAt);
}

/* --------------------------------------------------------------- commits */

/**
 * Commit one control. Called by Next — it returns immediately so navigation
 * is never blocked, and a new commit also retries everything already queued.
 *
 * `scope` is the assessment this answer belongs to. It scopes the client's own
 * memory of what it confirmed (see `answered`); it is deliberately NOT part of
 * the queued entry, because the server resolves the assessment from the session
 * at write time and an id travelling in the payload would be one more thing a
 * stale tab could aim at the wrong record.
 */
export function commit(
  entry: Omit<OutboxEntry, "tries" | "userId" | "queuedAt">,
  scope: string,
) {
  // Dwell survives a re-commit for the same reason `tries` and `queuedAt` do,
  // though it took a review pass to see it. It measures the time taken to
  // reach the FIRST answer for this control; a re-commit while the first is
  // still queued — offline, or a server wobble — is the same answer being
  // re-sent, not a new one being thought about. Taking the newer value there
  // would overwrite a real reading with the few seconds it took to click Next
  // again, and that control would then be reported as answered faster than its
  // own text can be read.
  // Changing your mind about a control that is ALREADY failing must not reset
  // its history: zeroing `tries` would unmount the failure banner while the
  // network is still down, and restart the backoff at 2s. Carry both forward.
  answered.set(answeredKey(scope, entry.control), entry.level);
  const previous = queue.find((e) => e.control === entry.control);
  queue = [...queue.filter((e) => e.control !== entry.control), {
    ...entry,
    dwellMs: entry.dwellMs ?? previous?.dwellMs ?? null,
    tries: previous?.tries ?? 0,
    queuedAt: previous?.queuedAt ?? Date.now(),
    userId: boundUserId,
  }];
  persist();
  publish();
  schedule(0);
}

export function retryNow() {
  schedule(0);
}

/** The queued answer for a control, if any — the outbox holds newer truth
 *  than the server render while an entry is still in flight. */
export function pendingFor(control: string): OutboxEntry | undefined {
  return queue.find((e) => e.control === control);
}

/**
 * The level this browser confirmed for a control, sent or not — `null` when it
 * has not been answered on this device this session.
 *
 * Deliberately NOT the same question as `pendingFor`, which asks "is this still
 * unsent" and drives the offline hint. This one asks "did the PM answer it",
 * which stays true after the server says ok. Screens that decide what the PM
 * has DONE must ask this; screens that report what is still IN FLIGHT ask the
 * other. Collapsing them is what produced N33.
 */
export function answeredLevel(scope: string, control: string): number | null {
  return answered.get(answeredKey(scope, control)) ?? null;
}

/** False once a localStorage write has failed. The offline banner promises
 *  answers are "saved on this device"; if that promise is not true, it must
 *  not be made. */
export function mirrorWorks(): boolean {
  return mirrorHealthy;
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
    let reject = false;
    try {
      // A server action has no timeout of its own: against a hung endpoint the
      // browser can wait minutes, and `flushing` blocks every other wake-up
      // in the meantime — including "the network came back". Bound it.
      const r = await Promise.race([
        save(entry),
        new Promise<{ ok: boolean; reject?: boolean }>((_, rej) =>
          setTimeout(() => rej(new Error("outbox: attempt timed out")), 15_000)),
      ]);
      ok = r.ok;
      reject = r.reject === true;
    } catch {
      ok = false;
    }
    const stillQueued = queue.find((q) => q.control === entry.control);
    if (ok || reject) {
      // `reject` means the server refused this entry on grounds that will
      // never change — the signed-in account is not the one that confirmed
      // it. Keeping it would retry a cross-account write every 30 seconds
      // forever; the answer stays in the owner's own mirror, under their key.
      // Only drop it if it is still the SAME answer. A re-commit during the
      // flush replaced the object; confirming the old value must not delete
      // the new one, which has not been sent yet.
      if (stillQueued === entry) queue = queue.filter((e) => e !== entry);
      if (reject) {
        /* Refused on identity grounds, so no record this browser can reach will
           ever hold it. Every scope is dropped, not just the one it was
           committed under: the refusal says this tab is signed in as somebody
           else, which invalidates the claim for any assessment it holds.
           Unconditional, and not guarded on the level — a re-commit at a
           different level would only be refused again, and the earlier guard
           protected nothing while reading as though it did.

           WHAT THIS DOES NOT DO, said plainly because the comment here used to
           overstate it: nothing subscribes to this map, so a card ALREADY on
           screen keeps its counts until the panel's effect next runs. The
           refusal path only ever fires in a tab whose session has moved to
           another account, where the whole render is already the wrong
           person's; correcting it for the next navigation is the honest scope
           of this line. Wiring a notification would mean publishing on a map
           the panel deliberately reads once per control. */
        for (const k of [...answered.keys()]) {
          if (k.endsWith(`|${entry.control}`)) answered.delete(k);
        }
        console.warn(`[outbox] ${entry.control} refused: not this account`);
      }
    } else {
      failed = true;
      // Increment the entry that is actually IN the queue, not the detached
      // object we started with — otherwise a re-commit mid-flight loses the
      // failure count, and the banner and backoff both work off a lie.
      const live = stillQueued ?? entry;
      live.tries += 1;
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
