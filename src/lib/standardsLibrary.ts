import path from "node:path";
import { promises as fs } from "node:fs";

/** Loader for the full standards library (standards/ in the harness repo -
 * the complete team ruleset, copied verbatim from the source documents).
 *
 * The ENGINE does the scoping deterministically: each instruction module
 * declares an applyTo glob in its frontmatter; a workflow step gets exactly
 * the modules whose glob matches the files that step touches. Same selection
 * logic for every LLM vendor - no vendor file-discovery conventions. */

interface Module {
  name: string;
  applyTo: RegExp | null; // path glob; null = no path scoping
  /** Salesforce-type scoping, e.g. "ApexTrigger", "Flow[recordTriggered]",
   * "ApexClass[test]". Resolved by path AND (for subtypes) file content -
   * granularity a path glob cannot express: *.flow-meta.xml cannot tell a
   * record-triggered flow from a screen flow, the XML inside can. */
  appliesToType: { type: string; subtype?: string } | null;
  /** Step roles this module serves (read/design/implement/review/trace);
   * null = every role. Code-mechanics rules (logging calls, test assertions,
   * PR readiness) are noise in a DESIGN prompt - the glob can't express that,
   * because a design step's scope files are the same code paths an implement
   * step touches. Both gates must pass: role AND path/type. */
  roles: Set<string> | null;
  body: string;
}

const TYPE_PATHS: Record<string, RegExp> = {
  apexclass: /\.cls$/i,
  apextrigger: /\.trigger$/i,
  flow: /\.flow-meta\.xml$/i,
  lwc: /(^|\/)lwc\//i,
  aura: /(^|\/)aura\//i,
};

const SUBTYPE_CONTENT: Record<string, RegExp> = {
  "apexclass.test": /@isTest/i,
  "apexclass.batch": /\bDatabase\.Batchable\b/i,
  "flow.recordtriggered": /<recordTriggerType>|<triggerType>\s*Record/i,
  "flow.screen": /<screens>/i,
};

function parseTypeSelector(v: string): Module["appliesToType"] {
  const m = v.trim().match(/^([A-Za-z]+)(?:\[([A-Za-z-]+)\])?$/);
  if (!m || !TYPE_PATHS[m[1].toLowerCase()]) return null;
  return { type: m[1].toLowerCase(), subtype: m[2]?.toLowerCase() };
}

/** Does the selector match at least one of the files? Subtype checks read the
 * file (root required); without a root - or an unreadable file - the subtype
 * is assumed to match, because injecting a standard too often is cheap and
 * missing one is not. */
async function typeMatches(
  sel: NonNullable<Module["appliesToType"]>,
  files: string[],
  root: string | undefined,
  contentCache: Map<string, string | null>,
): Promise<boolean> {
  const pathRe = TYPE_PATHS[sel.type];
  for (const f of files) {
    if (!pathRe.test(f)) continue;
    if (!sel.subtype) return true;
    const contentRe = SUBTYPE_CONTENT[`${sel.type}.${sel.subtype}`];
    if (!contentRe || !root) return true; // unknown subtype / no root: fail open
    if (!contentCache.has(f)) {
      const body = await fs
        .readFile(path.join(root, f), "utf8")
        .then((s) => s.slice(0, 64_000))
        .catch(() => null);
      contentCache.set(f, body);
    }
    const body = contentCache.get(f);
    if (body === null || body === undefined || contentRe.test(body)) return true;
  }
  return false;
}

let cache: { baseline: string; modules: Module[]; personas: Map<string, string> } | null = null;

function stdRoot() {
  // harness repo root - process.cwd() is where next dev/start runs; the
  // Electron shell overrides via env (standalone server cwd differs)
  return process.env.DHRUVA_STANDARDS_DIR ?? path.join(process.cwd(), "standards");
}

/** Convert an applyTo glob (e.g. force-app/main/default/ ** / *.cls) to a regex.
 * Exported: project skills reuse the same scoping syntax. */
export function globToRegex(glob: string): RegExp {
  // split on "**/" and "**" first so the single-"*" pass can't mangle the
  // regex fragments those expand to
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // brace expansion: "\{js,html\}" → "(?:js|html)"
  const braced = esc.replace(/\\\{([^}]*)\\\}/g, (_, inner: string) => {
    return `(?:${inner.split(",").map((s) => s.trim()).join("|")})`;
  });
  const body = braced
    .split("**/")
    .map((seg) =>
      seg
        .split("**")
        .map((p) => p.replace(/\*/g, "[^/]*"))
        .join(".*"),
    )
    .join("(?:.*/)?");
  return new RegExp(`(^|/)${body}$`, "i");
}

function parseFrontmatter(raw: string): {
  applyTo: string | null;
  appliesToType: string | null;
  roles: string | null;
  body: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { applyTo: null, appliesToType: null, roles: null, body: raw };
  const fm = m[1];
  const apply = fm.match(/applyTo:\s*["']?([^"'\r\n]+)["']?/);
  const type = fm.match(/appliesToType:\s*["']?([^"'\r\n]+)["']?/);
  const roles = fm.match(/roles:\s*["']?([^"'\r\n]+)["']?/);
  return {
    applyTo: apply ? apply[1].trim() : null,
    appliesToType: type ? type[1].trim() : null,
    roles: roles ? roles[1].trim() : null,
    body: raw.slice(m[0].length),
  };
}

const KNOWN_ROLES = new Set(["read", "design", "implement", "review", "trace"]);

function parseRoles(v: string): Set<string> | null {
  const roles = v
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter((r) => KNOWN_ROLES.has(r));
  // an all-invalid roles line must not silently hide the module everywhere -
  // fail open to "all roles", same stance as an unknown appliesToType subtype
  return roles.length > 0 ? new Set(roles) : null;
}

async function load() {
  if (cache) return cache;
  const root = stdRoot();
  const baseline = await fs.readFile(path.join(root, "baseline.md"), "utf8").catch(() => "");
  const modules: Module[] = [];
  const instDir = path.join(root, "instructions");
  for (const f of await fs.readdir(instDir).catch(() => [] as string[])) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(instDir, f), "utf8");
    const { applyTo, appliesToType, roles, body } = parseFrontmatter(raw);
    modules.push({
      name: f.replace(/\.instructions\.md$/, ""),
      applyTo: applyTo ? globToRegex(applyTo) : null,
      appliesToType: appliesToType ? parseTypeSelector(appliesToType) : null,
      roles: roles ? parseRoles(roles) : null,
      body: body.trim(),
    });
  }
  const personas = new Map<string, string>();
  const perDir = path.join(root, "personas");
  for (const f of await fs.readdir(perDir).catch(() => [] as string[])) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(perDir, f), "utf8");
    personas.set(f.replace(/\.agent\.md$/, ""), parseFrontmatter(raw).body.trim());
  }
  cache = { baseline, modules, personas };
  return cache;
}

/** The rules relevant to a set of files AND a step role: baseline + every
 * module whose applyTo glob or appliesToType selector matches at least one
 * file (modules with neither are always path-eligible), gated by the module's
 * `roles:` list when it declares one. With no files known yet (e.g.
 * investigation steps), returns baseline + unscoped modules only. `root`
 * enables content-based subtype checks (Flow[recordTriggered], ApexClass[test]);
 * without it, a matching type includes the module regardless of subtype. No
 * `role` given = no role filtering (fail open, never hide rules by accident). */
export async function standardsFor(
  files: string[],
  root?: string,
  role?: string,
): Promise<string> {
  const lib = await load();
  const norm = files.map((f) => f.replace(/\\/g, "/"));
  const parts: string[] = [];
  const contentCache = new Map<string, string | null>();
  if (lib.baseline) parts.push(lib.baseline.trim());
  for (const m of lib.modules) {
    if (m.roles && role && !m.roles.has(role)) continue;
    let applies = m.applyTo === null && m.appliesToType === null; // unscoped
    if (!applies && m.applyTo) applies = norm.some((f) => m.applyTo!.test(f));
    if (!applies && m.appliesToType) {
      applies = await typeMatches(m.appliesToType, norm, root, contentCache);
    }
    if (applies) parts.push(`## ${m.name}\n${m.body}`);
  }
  return parts.join("\n\n");
}

/** A persona body by name (e.g. "salesforce-review"), or empty string. */
export async function persona(name: string): Promise<string> {
  const lib = await load();
  return lib.personas.get(name) ?? "";
}

/** The whole shipped library for the read-only UI browser - so project-skill
 * authors can SEE what the standards already cover instead of duplicating it. */
export async function libraryIndex(): Promise<{
  baseline: { chars: number; body: string };
  modules: { name: string; body: string }[];
  personas: { name: string; body: string }[];
}> {
  const lib = await load();
  return {
    baseline: { chars: lib.baseline.length, body: lib.baseline.trim() },
    modules: lib.modules.map((m) => ({ name: m.name, body: m.body })),
    personas: [...lib.personas.entries()].map(([name, body]) => ({ name, body })),
  };
}
