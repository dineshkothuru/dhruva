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

// `dhruva update` — install the latest published version from the npm
// registry (immutable, versioned). `dhruva update edge` tracks the GitHub
// master branch instead (whatever was pushed last).
if (process.argv[2] === "update") {
  const edge = process.argv[3] === "edge";
  const source = edge ? "github:dineshkothuru/dhruva" : "dhruva@latest";
  console.log(`[dhruva] updating from ${edge ? "GitHub master (edge)" : "the npm registry"}...`);
  const r = spawnSync("npm", ["install", "-g", source], {
    shell: true,
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}
// `dhruva app` — fetch the latest desktop installer from GitHub Releases and
// launch it: one command from npm-land to the self-updating desktop app,
// no browser download needed.
if (process.argv[2] === "app") {
  (async () => {
    console.log("[dhruva] fetching the latest desktop installer...");
    const base = "https://github.com/dineshkothuru/dhruva/releases/latest/download/";
    const yml = await (await fetch(base + "latest.yml")).text();
    const name = (yml.match(/^path:\s*(.+)$/m) || [])[1]?.trim();
    if (!name || !/^[\w.-]+\.exe$/.test(name)) {
      console.error("[dhruva] could not resolve the installer from the release feed");
      process.exit(1);
    }
    const res = await fetch(base + name);
    if (!res.ok) {
      console.error(`[dhruva] download failed: HTTP ${res.status}`);
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = path.join(require("node:os").tmpdir(), name);
    await require("node:fs/promises").writeFile(dest, buf);
    console.log(
      `[dhruva] downloaded ${(buf.length / 1048576).toFixed(0)} MB - launching the installer` +
        ` (unsigned build: if SmartScreen appears, choose More info -> Run anyway)`,
    );
    if (process.platform === "win32") {
      spawnSync("cmd", ["/c", "start", "", dest], { shell: false });
    } else {
      console.log(`[dhruva] installer saved to ${dest} - run it to install`);
    }
  })().catch((e) => {
    console.error("[dhruva] " + (e && e.message ? e.message : e));
    process.exit(1);
  });
  return;
}
if (process.argv[2] === "version" || process.argv[2] === "--version") {
  console.log(`dhruva ${require(path.join(appRoot, "package.json")).version}`);
  process.exit(0);
}

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
