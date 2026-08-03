import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No remote or user-supplied images in this app; keeping the optimizer off
  // avoids the sharp/libvips path entirely.
  images: { unoptimized: true },
};

export default nextConfig;
