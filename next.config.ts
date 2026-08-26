import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone: self-contained server bundle (node .next/standalone/server.js)
  // — required for the Electron desktop packaging
  output: "standalone",
};

export default nextConfig;
