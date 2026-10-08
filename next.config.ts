import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Dev signs in through the LAN IP (the Authentik proxy refuses localhost),
  // and next dev blocks its own scripts for any other host, so the page would
  // never hydrate. Dev only; production ignores it.
  allowedDevOrigins: ["10.1.255.18"],
};

export default nextConfig;
