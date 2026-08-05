"use client";

import { useEffect, useState } from "react";
import { mirrorWorks } from "@/lib/outbox";

/**
 * "You are offline" — one statement, app-wide.
 *
 * Navigation is blocked while this is showing (see app/link.tsx), so the PM
 * needs to be told why rather than left clicking links that do nothing. It
 * pairs with the outbox banner: that one is about answers that FAILED to
 * save, this one is about the connection itself.
 *
 * Deliberately not merged with the outbox banner. They answer different
 * questions — "can I keep working?" and "is my work safe?" — and a PM who is
 * offline with a queued answer needs both answers, not a sentence trying to
 * be both.
 */
export default function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const read = () => setOffline(navigator.onLine === false);
    read();
    const down = () => setOffline(true);
    const up = () => setOffline(false);
    window.addEventListener("offline", down);
    window.addEventListener("online", up);
    // A page restored from the back/forward cache does NOT remount React or
    // re-run effects, so the mount-time read above cannot cover it — the tab
    // could have gone offline while frozen, or come back while frozen and be
    // stuck showing a warning that blocks every link. `pageshow` is the event
    // that actually fires on restore.
    window.addEventListener("pageshow", read);
    return () => {
      window.removeEventListener("offline", down);
      window.removeEventListener("online", up);
      window.removeEventListener("pageshow", read);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="banner banner-warn" role="status" aria-live="polite">
      <b>You are offline.</b>{" "}
      {mirrorWorks()
        ? "Answers you have already confirmed are saved on this device and will sync when you reconnect."
        : "This browser will not let the app store anything, so answers you have already confirmed are only held in this tab — keep it open until you reconnect."}{" "}
      Moving between controls is paused until then.
    </div>
  );
}
