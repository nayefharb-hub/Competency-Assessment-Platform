import "client-only";

/**
 * The navigation-pending signal behind the top progress bar.
 *
 * This app does client-side navigation (App Router), so the browser never spins
 * its own tab icon on an in-app click — no document load happens. Every route is
 * `force-dynamic` with prefetch off (N21) and no `loading.tsx`, so a click waits
 * on a live server render with nothing on screen. This store is the in-app
 * stand-in for the tab spinner: `<Link>` reports its `useLinkStatus` pending
 * here, and `<NavProgress>` reads it.
 *
 * MODULE SCOPE IS SAFE HERE, and the `import "client-only"` above is what makes
 * that true: it is per-TAB browser state, not per-request server state, so it is
 * NOT the Fluid-Compute module-scope hazard docs/deploy.md warns about. Importing
 * this into a server component is a build error, so it can never become one.
 *
 * A COUNT, not a boolean. Across one navigation React can hold the old subtree
 * mounted while the next loads, so more than one `<Link>` can read pending at
 * once; a bare boolean would clear on the first to settle. The bar is on while
 * the count is above zero. `pushPending` hands back an idempotent release so a
 * double-release (settle THEN unmount) cannot drive the count negative.
 */
let pending = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function pushPending(): () => void {
  pending += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pending = Math.max(0, pending - 1);
    emit();
  };
}

export function subscribePending(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function isNavPending(): boolean {
  return pending > 0;
}
