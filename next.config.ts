import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone: self-contained server bundle (node .next/standalone/server.js)
  // — required for the Electron desktop packaging
  output: "standalone",
  // file tracing must NEVER pull build artifacts into the standalone bundle —
  // dist-app holds previous installers (recursive packaging grows unbounded)
  outputFileTracingExcludes: {
    "*": ["dist-app/**", ".git/**", "dist-app"],
  },
};

export default nextConfig;
