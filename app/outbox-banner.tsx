"use client";

import { useSyncExternalStore, useEffect, useState } from "react";
import { configure, getServerSnapshot, getSnapshot, retryNow, subscribe, wireBrowserEvents } from "@/lib/outbox";
import { commitSelfScoreAction } from "@/app/actions";

/**
 * The one place the app admits a save has not landed.
 *
 * It lives in the root layout rather than on the assessment page because the
 * failure outlives the page: a PM can commit an answer, walk to Results, and
 * only then have the write fail. The count follows them.
 *
 * Silent on the happy path — a banner that appears when everything is fine is
 * how people learn to ignore banners.
 */
export default function OutboxBanner({ userId }: { userId: string }) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Binding lives HERE rather than on the assessment page because this
  // component is on every page: a PM who reloads on Results during an outage
  // must still see the warning and still have the queue retried. The e2e
  // outage test asserts exactly that.
  useEffect(() => {
    configure(userId, (e) =>
      commitSelfScoreAction(e.control, e.level, e.evidence, e.userId, e.dwellMs ?? null));
    wireBrowserEvents();
  }, [userId]);
  const [now, setNow] = useState(() => Date.now());

  // Only tick while there is a countdown to show. A timer that runs on every
  // page for the 99.9% of the time nothing is wrong is pure waste.
  // Tick whenever anything is queued: the "stuck" test below is time-based,
  // so a frozen clock would keep the banner hidden through an outage.
  const ticking = state.pending.length > 0;
  useEffect(() => {
    if (!ticking) return;
    // Re-read immediately. Leaving `now` at whatever it was when the last
    // queue drained made the first paint of a NEW failure compute its
    // countdown against a minutes-old clock and announce "retrying in 419s".
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [ticking]);

  // Speak up when something has actually FAILED — not while a commit is
  // merely in flight, which happens on every Next for ~300ms and would turn
  // the one banner that means "act on this" into wallpaper.
  //
  // But `tries` only rises AFTER an attempt returns, and against a hung
  // server that can take minutes: the answers would sit unsent with nothing
  // on screen saying so, and the panel's own "not saved yet" note is gone the
  // moment the PM navigates. So age counts too — an answer that has been
  // queued for more than a few seconds is not "in flight", it is stuck.
  const STUCK_AFTER_MS = 5_000;
  const failed = state.pending.filter((e) => e.tries > 0 || now - e.queuedAt > STUCK_AFTER_MS);
  if (failed.length === 0) return null;

  const n = failed.length;
  const answers = n === 1 ? "1 answer" : `${n} answers`;
  const secs = state.nextAttemptAt ? Math.max(0, Math.ceil((state.nextAttemptAt - now) / 1000)) : 0;

  return (
    <div className="outbox-banner" role="status" aria-live="polite">
      <span>
        <b>{answers}</b> not saved yet —{" "}
        {state.flushing ? "saving now…" : secs > 0 ? `retrying in ${secs}s` : "retrying…"}
      </span>
      <button className="btn btn-sm" type="button" onClick={retryNow} disabled={state.flushing}>
        Retry now
      </button>
    </div>
  );
}
