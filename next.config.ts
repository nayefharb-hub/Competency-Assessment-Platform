import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No remote or user-supplied images in this app; keeping the optimizer off
  // avoids the sharp/libvips path entirely.
  images: { unoptimized: true },

  /*
   * /login must never be restored from the browser's back/forward cache (N22).
   *
   * The redirect for an already-signed-in visitor lives in the page, so it only
   * runs when the server is actually asked. Pressing Back does not ask: Chrome
   * restores the page from bfcache and the guard never executes — which is the
   * owner's exact reported route in, and it survived the first fix precisely
   * because the fix was server-side and Back is not.
   *
   * `no-store` makes the response bfcache-ineligible, so Back becomes a real
   * request and the guard runs. Scoped to /login alone: every other route is
   * already `force-dynamic`, and making the whole app unrestorable would be a
   * needless cost paid on every navigation.
   */
  async headers() {
    return [{
      source: "/login",
      headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
    }];
  },
};

export default nextConfig;
