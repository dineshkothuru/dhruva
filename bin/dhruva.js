#!/usr/bin/env node
/** Dhruva launcher — the `dhruva` command (Claude Code-style install).
 *
 * Runs the app from wherever the package is installed, on the user's machine,
 * with the user's own logins (sf / copilot / claude / codex). No credentials
 * ship with, or ever pass through, this package. */

const { spawnSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const appRoot = path.join(__dirname, "..");
const port = process.env.DHRUVA_PORT || "3005";

function has(cmd) {
  const probe = spawnSync(cmd, ["--version"], { shell: true, stdio: "ignore" });
  return probe.status === 0;
}

console.log("[dhruva] checking prerequisites...");
if (!has("sf")) {
  console.log("[dhruva] Salesforce CLI missing - installing (@salesforce/cli)...");
  const r = spawnSync("npm", ["install", "-g", "@salesforce/cli"], {
    shell: true,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("[dhruva] could not install the Salesforce CLI - install it manually and re-run.");
    process.exit(1);
  }
}
// Local Dev plugin (visual testing: local UI files + live org data)
const plugins = spawnSync("sf", ["plugins"], { shell: true, encoding: "utf8" });
if (plugins.status === 0 && !String(plugins.stdout).includes("lightning-dev")) {
  console.log("[dhruva] installing the Salesforce Local Dev plugin (visual testing)...");
  spawnSync("sf", ["plugins", "install", "@salesforce/plugin-lightning-dev"], {
    shell: true,
    stdio: "inherit",
  });
}

const agents = ["copilot", "claude", "codex"].filter(has);
if (agents.length === 0) {
  console.log("[dhruva] WARNING: no agent CLI found. Install at least one and log in once:");
  console.log("   npm install -g @github/copilot        (then: copilot, use /login)");
  console.log("   npm install -g @anthropic-ai/claude-code   (then: claude)");
  console.log("   npm install -g @openai/codex          (then: codex login)");
} else {
  console.log(`[dhruva] agent CLIs found: ${agents.join(", ")}`);
}

// dependencies + build (first run after a source install)
if (!existsSync(path.join(appRoot, "node_modules"))) {
  console.log("[dhruva] installing dependencies (first run)...");
  const r = spawnSync("npm", ["ci", "--omit=dev"], { cwd: appRoot, shell: true, stdio: "inherit" });
  if (r.status !== 0) {
    spawnSync("npm", ["install"], { cwd: appRoot, shell: true, stdio: "inherit" });
  }
}
if (!existsSync(path.join(appRoot, ".next", "BUILD_ID"))) {
  console.log("[dhruva] building (first run, takes a minute)...");
  const r = spawnSync("npm", ["run", "build"], { cwd: appRoot, shell: true, stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}

console.log(`[dhruva] starting on http://localhost:${port}`);
const opener =
  process.platform === "win32" ? ["cmd", ["/c", "start", "", `http://localhost:${port}`]] :
  process.platform === "darwin" ? ["open", [`http://localhost:${port}`]] :
  ["xdg-open", [`http://localhost:${port}`]];
setTimeout(() => {
  try {
    spawn(opener[0], opener[1], { shell: false, stdio: "ignore", detached: true }).unref();
  } catch {
    /* user opens the URL manually */
  }
}, 2500);

const server = spawn("npx", ["next", "start", "-p", port], {
  cwd: appRoot,
  shell: true,
  stdio: "inherit",
});
server.on("close", (code) => process.exit(code ?? 0));
