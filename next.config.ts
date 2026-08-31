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
  // The language servers are spawned as processes, and the file that gets
  // spawned is lib/server.js - a four-line bootstrap that is NOT an exported
  // subpath, so nothing can reference it statically and the tracer never sees
  // it. The tracer anchors in src/lib/lsp/servers.ts pull in each package and
  // its whole dependency closure via the exported "/server" path; these two
  // lines add the bootstrap itself. Without them the packaged app has the
  // packages but not the entry point, and completions silently do nothing.
  outputFileTracingIncludes: {
    "/api/lang-suggest": [
      "./node_modules/@salesforce/lwc-language-server/lib/server.js",
      "./node_modules/@salesforce/aura-language-server/lib/server.js",
      // lightning-lsp-common ships jsconfig/tsconfig templates that it reads at
      // RUNTIME, so the tracer never sees them and they were absent from the
      // packaged app. Listed one by one on purpose: a `resources/**` glob here
      // made Turbopack fail the whole build with an internal error
      // ("Failed to write app endpoint /page"), reproducibly and with a clean
      // .next. Six explicit paths build fine.
      "./node_modules/@salesforce/lightning-lsp-common/lib/resources/core/core.code-workspace.json",
      "./node_modules/@salesforce/lightning-lsp-common/lib/resources/core/jsconfig-core.json",
      "./node_modules/@salesforce/lightning-lsp-common/lib/resources/core/settings-core.json",
      "./node_modules/@salesforce/lightning-lsp-common/lib/resources/sfdx/jsconfig-sfdx.json",
      "./node_modules/@salesforce/lightning-lsp-common/lib/resources/sfdx/tsconfig-sfdx.base.json",
      "./node_modules/@salesforce/lightning-lsp-common/lib/resources/sfdx/tsconfig-sfdx.json",
    ],
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
