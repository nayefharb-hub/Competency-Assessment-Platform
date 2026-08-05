"use client";

import { useEffect, useState } from "react";

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
    // Read once on mount too: the tab may have gone offline before this
    // component existed, e.g. a page restored from the back/forward cache.
    setOffline(navigator.onLine === false);
    const down = () => setOffline(true);
    const up = () => setOffline(false);
    window.addEventListener("offline", down);
    window.addEventListener("online", up);
    return () => {
      window.removeEventListener("offline", down);
      window.removeEventListener("online", up);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="banner banner-warn" role="status" aria-live="polite">
      <b>You are offline.</b> Answers you have already confirmed are saved on
      this device and will sync when you reconnect. Moving between controls is
      paused until then.
    </div>
  );
}
