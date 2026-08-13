"use client";

import NextLink, { useLinkStatus } from "next/link";
import { useEffect } from "react";
import type { ComponentProps } from "react";
import { pushPending } from "./nav-progress-store";

/**
 * `<Link>`, with prefetching off by default (N21).
 *
 * THIS IS CONDITIONAL ON THE APP'S CURRENT SHAPE. Read the rest before removing
 * it — the answer changes the moment either condition below changes.
 *
 * Next prefetches a link's destination when the link becomes visible, so the
 * click feels instant. On a static route that is a real win: the payload is in
 * the browser before the click. Here it is not, because Next will not render a
 * dynamic page for a prefetch — it fetches down to the nearest `loading.tsx`
 * boundary and stops.
 *
 * Every route in this app is `force-dynamic`, and there is no `loading.tsx`
 * anywhere. So a prefetch has nothing it is allowed to return. Measured against
 * production: **98 of 101 `_rsc` requests came back having made zero database
 * calls.** They did not render a page. They fetched nothing usable.
 *
 * Empty is not free. Each is a real function invocation, and this app fires them
 * in bursts — five nav links in the header of every signed-in page, and one per
 * control on the index, which is 132. Six landing at once makes Vercel
 * cold-start instances to absorb them: one single-user session produced twelve
 * instances, four of which served exactly one request and were never used again.
 *
 * The cost does not land on the page the prefetch belongs to. It lands on the
 * NEXT click, which may hit a cold instance — where server-action overhead is
 * 421-779ms against 210ms warm.
 *
 * ── PUT PREFETCHING BACK when either of these becomes true ──
 *
 *   1. A `loading.tsx` boundary exists on the route. A prefetch then has
 *      something real to fetch and paint instantly on click, and it earns its
 *      invocation.
 *   2. A route stops being `force-dynamic`. Static or partially-static routes
 *      prefetch their full payload, which is the case prefetching exists for.
 *
 * This is not "prefetching is bad". It is "prefetching is unpaid-for in this
 * app, today". The default lives in one file so that when the shape changes,
 * turning it back on is one edit rather than an archaeology exercise across
 * twenty-six call sites.
 *
 * `{...props}` comes after the default, so any single link can still opt in
 * with an explicit `prefetch`.
 */
export default function Link({ children, onClick, ...props }: ComponentProps<typeof NextLink>) {
  // prefetch stays in `...props` so a single link can still opt in explicitly
  // (the N21 default is off); the guarded onClick and the pending reporter are
  // the two things this seam adds on top of NextLink.
  return (
    <NextLink prefetch={false} {...props} onClick={guardOffline(onClick)}>
      {children}
      <NavPending />
    </NextLink>
  );
}

/**
 * Reports THIS link's navigation-pending state to the shared store that drives
 * the top progress bar. Rendered inside every `<Link>` (this is the one seam all
 * in-app navigation passes through), it reads `useLinkStatus` for the enclosing
 * link and renders nothing — no DOM node, so it changes no link's layout.
 *
 * `useLinkStatus` goes pending the moment the click starts a navigation and
 * clears when the destination has fully rendered — exactly the window with no
 * on-screen feedback today. The effect's cleanup releases the count on settle OR
 * on unmount (the clicked in-page link unmounts when its page is replaced), so a
 * navigation can never leave the bar stuck on.
 */
function NavPending() {
  const { pending } = useLinkStatus();
  useEffect(() => {
    if (!pending) return;
    return pushPending();
  }, [pending]);
  return null;
}

/**
 * Every in-app navigation goes through here, which makes this the one place
 * that can keep an offline click from destroying the app.
 *
 * MEASURED, not assumed: with no connection, a client-side navigation fails
 * and Next falls back to a full page load, which lands on the browser's own
 * error page. The app is gone — and with it the banner that would have told
 * the PM their answers are safe.
 *
 * The score panel's "Next control" already refuses to navigate when offline,
 * and guarding only that button would have made Previous and the header links
 * behave differently in the same situation, which is worse than either
 * behaviour on its own. So the check lives at the seam every link shares.
 *
 * `navigator.onLine` is a property read — no I/O, nothing to pay for on a
 * click. It is also only as good as the browser's idea of connectivity: a
 * captive portal reads as online, the navigation fails anyway, and the outbox
 * retry is what covers that case.
 */
function guardOffline(
  onClick: ComponentProps<typeof NextLink>["onClick"],
): ComponentProps<typeof NextLink>["onClick"] {
  return (e) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      e.preventDefault();
      // The app-wide offline banner is already on screen saying why, so this
      // is deliberately silent rather than a second, competing message.
      return;
    }
    onClick?.(e);
  };
}
