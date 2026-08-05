"use client";

import { useSyncExternalStore, useState } from "react";
import { getServerSnapshot, getSnapshot, retryNow, subscribe } from "@/lib/outbox";

/**
 * Sign out, but not on top of unsaved answers.
 *
 * Signing out is the one exit that cannot be walked back: the next session may
 * be a different person on the same machine, and the queued answers sit in
 * this browser's storage until someone signs in as their owner again. So the
 * link does what `docs/eng-plan-save-ux.md` specified and the first build
 * skipped — try once more, and if that fails, say so and let the PM choose.
 *
 * Deliberately NOT silent in either direction: leaving without a word would
 * strand answers the PM believes are saved, and blocking sign-out outright
 * would trap someone who needs to hand the machine over.
 */
export default function SignOutLink() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [flushing, setFlushing] = useState(false);

  async function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (state.pending.length === 0) return;      // nothing owed, go
    e.preventDefault();
    if (flushing) return;
    setFlushing(true);

    // One deliberate attempt, then stop asking them to wait. Three seconds is
    // the whole budget: a save that has not landed by then is not going to on
    // this click, and the mirror is what covers it.
    retryNow();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && getSnapshot().pending.length > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
    setFlushing(false);

    const left = getSnapshot().pending.length;
    if (left === 0) {
      window.location.href = "/logout";
      return;
    }

    // Plain words, and the truth: the answers are not lost, but they are not
    // on the server either, and they need THIS browser and THIS account to
    // finish the journey.
    const ok = window.confirm(
      `${left === 1 ? "1 answer has" : `${left} answers have`} not been saved yet.\n\n` +
      `They are kept on this browser and will be sent the next time you sign in here. ` +
      `If someone else uses this computer, they will not be sent until you return.\n\n` +
      `Sign out anyway?`,
    );
    if (ok) window.location.href = "/logout";
  }

  return (
    <a href="/logout" onClick={onClick}>
      {flushing ? "Saving…" : "Sign out"}
    </a>
  );
}
