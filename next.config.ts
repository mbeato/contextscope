import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Bundles a self-contained `.next/standalone/server.js` + minimal node_modules
  // so the npm package can ship a runnable server with `node server.js`.
  output: "standalone",
};

export default nextConfig;
