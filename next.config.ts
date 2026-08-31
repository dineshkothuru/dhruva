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
  // The language servers are SPAWNED as node processes, never imported into
  // the request path, so bundling them is both pointless and harmful: inside
  // the server bundle `require.resolve` returns a bundler module id rather
  // than a file path, and the spawn then has nothing to run. Externalising
  // them keeps Node's own resolution at runtime while still letting the
  // tracer copy them into the standalone bundle the desktop build ships.
  serverExternalPackages: [
    "@salesforce/lwc-language-server",
    "@salesforce/aura-language-server",
    // @salesforce/core resolves auth from the user's home directory and does
    // its own dynamic requires; bundling it breaks both.
    "@salesforce/core",
    "@salesforce/templates",
  ],
};

export default nextConfig;
