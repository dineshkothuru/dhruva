import path from "node:path";
import { promises as fs } from "node:fs";

/** Loader for the full standards library (standards/ in the harness repo —
 * the complete team ruleset, copied verbatim from the source documents).
 *
 * The ENGINE does the scoping deterministically: each instruction module
 * declares an applyTo glob in its frontmatter; a workflow step gets exactly
 * the modules whose glob matches the files that step touches. Same selection
 * logic for every LLM vendor — no vendor file-discovery conventions. */

interface Module {
  name: string;
  applyTo: RegExp | null; // null = always applies
  body: string;
}

let cache: { baseline: string; modules: Module[]; personas: Map<string, string> } | null = null;

function stdRoot() {
  // harness repo root — process.cwd() is where next dev/start runs; the
  // Electron shell overrides via env (standalone server cwd differs)
  return process.env.DHRUVA_STANDARDS_DIR ?? path.join(process.cwd(), "standards");
}

/** Convert an applyTo glob (e.g. force-app/main/default/ ** / *.cls) to a regex. */
function globToRegex(glob: string): RegExp {
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

function parseFrontmatter(raw: string): { applyTo: string | null; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { applyTo: null, body: raw };
  const fm = m[1];
  const apply = fm.match(/applyTo:\s*["']?([^"'\r\n]+)["']?/);
  return { applyTo: apply ? apply[1].trim() : null, body: raw.slice(m[0].length) };
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
    const { applyTo, body } = parseFrontmatter(raw);
    modules.push({
      name: f.replace(/\.instructions\.md$/, ""),
      applyTo: applyTo ? globToRegex(applyTo) : null,
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

/** The rules relevant to a set of files: baseline + every module whose
 * applyTo matches at least one file (unscoped modules always included).
 * With no files known yet (e.g. investigation steps), returns baseline +
 * unscoped modules only. */
export async function standardsFor(files: string[]): Promise<string> {
  const lib = await load();
  const norm = files.map((f) => f.replace(/\\/g, "/"));
  const parts: string[] = [];
  if (lib.baseline) parts.push(lib.baseline.trim());
  for (const m of lib.modules) {
    if (m.applyTo === null || norm.some((f) => m.applyTo!.test(f))) {
      parts.push(`## ${m.name}\n${m.body}`);
    }
  }
  return parts.join("\n\n");
}

/** A persona body by name (e.g. "salesforce-review"), or empty string. */
export async function persona(name: string): Promise<string> {
  const lib = await load();
  return lib.personas.get(name) ?? "";
}
