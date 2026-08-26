import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone: self-contained server bundle (node .next/standalone/server.js)
  // — required for the Electron desktop packaging ONLY. Normal installs run
  // `next start`, which is incompatible with standalone output, so the mode
  // is opt-in via the app:dist script.
  output: process.env.DHRUVA_STANDALONE ? "standalone" : undefined,
  // file tracing must NEVER pull build artifacts into the standalone bundle —
  // dist-app holds previous installers (recursive packaging grows unbounded)
  outputFileTracingExcludes: {
    "*": ["dist-app/**", ".git/**", "dist-app"],
  },
};

export default nextConfig;
