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
    configure(userId, (e) => commitSelfScoreAction(e.control, e.level, e.evidence));
    wireBrowserEvents();
  }, [userId]);
  const [now, setNow] = useState(() => Date.now());

  // Only tick while there is a countdown to show. A timer that runs on every
  // page for the 99.9% of the time nothing is wrong is pure waste.
  const counting = state.pending.length > 0 && !state.flushing && state.nextAttemptAt !== null;
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [counting]);

  if (state.pending.length === 0) return null;

  const n = state.pending.length;
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
