import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The language servers Dhruva can drive, as a table.
 *
 * A table rather than one hard-coded LWC integration, because the second and
 * third servers are already foreseeable: Aura is the same package family and is
 * shipped alongside, and GitHub's Copilot Language Server speaks the same
 * protocol over the same transport. Adding one should be a row here plus a
 * scope predicate, not another client. */

export interface LangServer {
  id: string;
  label: string;
  /** Absolute path of the node script to spawn, or null when the package is
   * not installed (the feature then degrades to nothing, not to an error). */
  entry: () => string | null;
  /** Does this server handle the given project-relative file? */
  handles: (rel: string) => boolean;
  /** The LSP languageId to declare for a file. Servers route on this. */
  languageId: (rel: string) => string;
  /** Characters that should re-trigger completion in the editor. */
  triggerCharacters: string[];
}

/** Resolve a language server's spawnable entry point.
 *
 * Three traps in the package itself, all verified against the install:
 *
 *  1. `bin/lwc-language-server.js` is NOT in the package's `exports`, so
 *     require.resolve on that subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 *  2. `main` points at `lib/indexer.js`, which does not exist, so resolving the
 *     bare package name throws MODULE_NOT_FOUND.
 *  3. The bin is a two-line wrapper whose whole body is
 *     `require('../lib/server.js')`, so spawning lib/server.js is equivalent.
 *
 * And one trap in the bundler, which cost the most time. A bare
 * `require.resolve("@salesforce/lwc-language-server/server")` inside an App
 * Route does NOT return a path - Turbopack rewrites it to a bundler module id:
 *
 *   [externals]\@salesforce\lwc-language-server\server [external] (...)
 *
 * `serverExternalPackages` does not change that. Spawning that string fails, and
 * the first version of this code had no existence check, so the failure looked
 * like a server that was permanently "indexing the project".
 *
 * createRequire's `resolve` is a method on a runtime value, so the bundler
 * cannot rewrite it, and it resolves against real node_modules. The base is
 * cwd/package.json, which is the project root in dev and the standalone root in
 * the packaged desktop build - node_modules sits beside both.
 *
 * The single existsSync is deliberate and deliberately NOT a search loop: a
 * loop calling existsSync on computed paths makes Turbopack trace the ENTIRE
 * project into the server output, which is the unbounded bundle growth
 * next.config.ts already fights. */
function entryFor(pkg: string): string | null {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    const lib = path.dirname(req.resolve(pkg + "/server"));
    const entry = path.join(lib, "server.js");
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

const LWC_DIR = /(^|\/)lwc\//;
const AURA_DIR = /(^|\/)aura\//;

function ext(rel: string): string {
  const i = rel.lastIndexOf(".");
  return i < 0 ? "" : rel.slice(i + 1).toLowerCase();
}

/** Language id by extension. Not a fancy mapping - just the ones these two
 * servers actually receive. */
function idFor(rel: string): string {
  switch (ext(rel)) {
    case "html":
      return "html";
    case "js":
      return "javascript";
    case "ts":
      return "typescript";
    case "css":
      return "css";
    case "cmp":
    case "app":
    case "evt":
    case "intf":
    case "design":
    case "auradoc":
    case "tokens":
      return "html";
    default:
      return "plaintext";
  }
}

export const LANG_SERVERS: LangServer[] = [
  {
    id: "lwc",
    label: "LWC",
    entry: () => entryFor("@salesforce/lwc-language-server"),
    // Scoped by PATH, not by language: .html is `html` to Monaco whether it is
    // an LWC template or a plain page, and .js is `javascript` whether it is a
    // component or a build script. Only files inside an lwc/ folder are LWC.
    handles: (rel) => {
      const p = rel.replace(/\\/g, "/");
      if (!LWC_DIR.test(p)) return false;
      return ["html", "js", "ts", "css"].includes(ext(p));
    },
    languageId: idFor,
    triggerCharacters: ["<", " ", "-", ":", ".", '"', "'", "/", "{"],
  },
  {
    id: "aura",
    label: "Aura",
    entry: () => entryFor("@salesforce/aura-language-server"),
    handles: (rel) => {
      const p = rel.replace(/\\/g, "/");
      if (!AURA_DIR.test(p)) return false;
      return ["cmp", "app", "evt", "intf", "design", "auradoc", "tokens", "js", "css"].includes(
        ext(p),
      );
    },
    languageId: idFor,
    triggerCharacters: ["<", " ", "-", ":", ".", '"', "'", "{", "!"],
  },
];

/** The server responsible for a file, or null when none is. */
export function serverFor(rel: string): LangServer | null {
  return LANG_SERVERS.find((s) => s.handles(rel)) ?? null;
}

export function serverById(id: string): LangServer | null {
  return LANG_SERVERS.find((s) => s.id === id) ?? null;
}
