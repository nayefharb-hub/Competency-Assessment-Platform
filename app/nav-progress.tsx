"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { isNavPending, resetPending, subscribePending } from "./nav-progress-store";

/**
 * The top progress bar — a thin indeterminate line that runs across the top edge
 * while an in-app navigation is in flight, then fades when the new page lands.
 * It is the in-app equivalent of the browser's tab spinner, which never fires on
 * client-side navigation (see nav-progress-store.ts).
 *
 * Rendered once in the layout. The bar itself is CSS; this component only owns
 * WHEN it shows.
 */
export default function NavProgress() {
  // getServerSnapshot is always false: the bar is a client-only affordance and
  // must render nothing during SSR, or hydration would mismatch.
  const pending = useSyncExternalStore(subscribePending, isNavPending, () => false);

  // Drain the pending count on every committed route change. This is the safety
  // net for the persistent header links (they never unmount, so a superseded
  // navigation could otherwise leave one pending forever and pin the bar on):
  // once a new route is on screen, nothing is still in flight. `usePathname` is
  // used, not `useSearchParams`, on purpose — the latter needs a Suspense
  // boundary and would bail this layout-level component to client rendering.
  const pathname = usePathname();
  useEffect(() => {
    resetPending();
  }, [pathname]);

  // Delay before showing, so a fast (warm) navigation that lands well under the
  // threshold never flashes a bar. A cold Fluid-Compute render runs seconds and
  // crosses it easily; a ~200ms warm one does not, which is the point.
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(t);
  }, [pending]);

  return (
    <div className={`navprogress${show ? " on" : ""}`} aria-hidden="true">
      <span className="navprogress-bar" />
    </div>
  );
}
