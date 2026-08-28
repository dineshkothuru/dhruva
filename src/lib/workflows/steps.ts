import path from "node:path";
import { promises as fs } from "node:fs";
import type { StepDef } from "./schema";

/** The step library.
 *
 * Steps used to be declared inline in every workflow JSON, which meant a long
 * prompt lived as a single escaped line inside a JSON string: unreadable,
 * undiffable, and impossible to reuse. The deterministic steps were copied
 * verbatim into every workflow that needed them.
 *
 * Now each step is one file in steps/, and a workflow names the steps it wants.
 * The file is frontmatter plus a body, and THE BODY IS THE STEP'S HUMAN TEXT -
 * the prompt for an agent step, the message for a gate. Everything else is a
 * scalar in the frontmatter.
 *
 *     ---
 *     id: analyse
 *     type: agent
 *     role: design
 *     persona: salesforce-architect
 *     readOnly: true
 *     ---
 *     A requirement needs a solution design for THIS org's codebase...
 *
 * Reuse is real but narrower than the id-sharing suggested: `snapshot` and
 * `changes` genuinely differ only by title, while the four steps historically
 * called `implement` have four entirely different prompts. A step id was a
 * workflow-local NAME, not a shared definition. So each distinct definition is
 * its own file, and a workflow may rename it at use with `as` - which keeps the
 * run-time step ids exactly as they were, so autoRevise targets, reviseTarget,
 * {steps.x.output} references and every existing run record still resolve. */

function stepsDir(): string {
  // packaged desktop app sets this (resources path); dev/CLI use the repo dir
  return process.env.DHRUVA_STEPS_DIR ?? path.join(process.cwd(), "steps");
}

/** Fields a workflow may override at the point of use. Deliberately small:
 * these are presentational or wiring, never the step's substance. A different
 * prompt means a different step, and therefore a different file - and so does a
 * different gate `message`, which is the whole substance of a gate. */
export const OVERRIDABLE = [
  "title",
  "timeoutMinutes",
  "onlyIf",
  "optional",
  "detached",
  "tasksFile",
  "taskLoop",
  "reviseTarget",
  "autoRevise",
] as const;

/** How a workflow names a step: a bare id, or an id plus overrides. */
export interface StepRef {
  use: string;
  /** the id this step takes inside the run (default: the library file's id) */
  as?: string;
  [k: string]: unknown;
}

const SCALAR = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;

function coerce(raw: string): string | number | boolean {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Strict, small frontmatter parser: scalars, one level of nesting, and
 * string arrays. No YAML beyond that - anything else is a mistake we would
 * rather see fail loudly than half-parse. */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  let nestKey: string | null = null;
  let arrKey: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indented = /^\s+/.test(line);
    const trimmed = line.trim();

    if (indented && arrKey) {
      if (trimmed.startsWith("- ")) {
        (meta[arrKey] as string[]).push(String(coerce(trimmed.slice(2))));
        continue;
      }
      arrKey = null;
    }
    if (indented && nestKey) {
      const sm = trimmed.match(SCALAR);
      if (sm) {
        (meta[nestKey] as Record<string, unknown>)[sm[1]] = coerce(sm[2]);
        continue;
      }
      nestKey = null;
    }
    const sm = trimmed.match(SCALAR);
    if (!sm) continue;
    const [, key, rest] = sm;
    nestKey = null;
    arrKey = null;
    if (rest.trim() === "") {
      // a bare "key:" opens either a nested object or a list; the next
      // indented line decides which
      const idx = lines.indexOf(line);
      const next = lines.slice(idx + 1).find((l) => l.trim());
      if (next && next.trim().startsWith("- ")) {
        meta[key] = [];
        arrKey = key;
      } else {
        meta[key] = {};
        nestKey = key;
      }
      continue;
    }
    meta[key] = coerce(rest);
  }
  // the body is everything after the closing fence, verbatim; one trailing
  // newline is the file's, not the content's
  let body = text.slice(m[0].length);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  if (body.endsWith("\r")) body = body.slice(0, -1);
  return { meta, body };
}

/** Turn one step file into a StepDef. The body lands on `prompt` for an agent
 * step and `message` for a gate - the two places a step carries prose. */
export function stepFromFile(text: string, fallbackId: string): StepDef {
  const { meta, body } = parseFrontmatter(text);
  const def = { ...meta } as Record<string, unknown>;
  def.id = typeof meta.id === "string" && meta.id ? meta.id : fallbackId;
  if (body) {
    if (meta.type === "gate") def.message = body;
    else def.prompt = body;
  }
  return def as unknown as StepDef;
}

let cache: Record<string, StepDef> | null = null;

/** Every step in the library, by file id. Cached in production, re-read in dev
 * so editing a step file hot-reloads like the workflow files already do. */
export async function loadStepLibrary(): Promise<Record<string, StepDef>> {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const dir = stepsDir();
  const out: Record<string, StepDef> = {};
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    throw new Error(
      `step library not found at ${dir} - broken install (set DHRUVA_STEPS_DIR or run from the repo root)`,
    );
  }
  for (const f of files.sort()) {
    const text = await fs.readFile(path.join(dir, f), "utf8");
    const def = stepFromFile(text, f.slice(0, -3));
    out[f.slice(0, -3)] = def;
  }
  if (Object.keys(out).length === 0) throw new Error(`no step files found in ${dir}`);
  cache = out;
  return out;
}

/** Resolve one workflow entry - a bare id or a {use, as, ...overrides} - into
 * a concrete StepDef. Throws on an unknown step or a disallowed override, so a
 * broken workflow fails at load instead of mid-run. */
export function resolveStep(entry: string | StepRef, library: Record<string, StepDef>): StepDef {
  const ref: StepRef = typeof entry === "string" ? { use: entry } : entry;
  const base = library[ref.use];
  if (!base) {
    throw new Error(`step "${ref.use}" is not in the step library`);
  }
  const def: StepDef = { ...base };
  if (ref.as) def.id = ref.as;
  for (const [k, v] of Object.entries(ref)) {
    if (k === "use" || k === "as" || v === undefined) continue;
    if (!(OVERRIDABLE as readonly string[]).includes(k)) {
      throw new Error(
        `step "${ref.use}": "${k}" cannot be overridden at the point of use - ` +
          `a step whose ${k} differs is a different step, so give it its own file`,
      );
    }
    (def as unknown as Record<string, unknown>)[k] = v;
  }
  return def;
}

/** Is this workflow entry a library reference rather than an inline step?
 * Inline steps stay supported forever: user-authored custom workflows are
 * already saved on disk with steps written out in full. */
export function isStepRef(entry: unknown): entry is string | StepRef {
  if (typeof entry === "string") return true;
  return (
    !!entry &&
    typeof entry === "object" &&
    typeof (entry as StepRef).use === "string" &&
    !("type" in (entry as object))
  );
}
