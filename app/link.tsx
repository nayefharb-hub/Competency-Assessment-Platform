import NextLink from "next/link";
import type { ComponentProps } from "react";

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
export default function Link(props: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={false} {...props} />;
}
