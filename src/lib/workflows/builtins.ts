import path from "node:path";
import { promises as fs } from "node:fs";
import type { WorkflowDef } from "./schema";
import { validateWorkflowDef } from "./validate";

/** Built-in workflow library — shipped as workflows/*.json (same pattern as
 * the standards/ folder) and validated by the SAME contract as customs, so
 * the shipped set and the custom validator can never drift apart. Read-only
 * in the product: customize by duplicating into the custom store, never by
 * editing shipped files — same id must mean same audited behavior everywhere. */

function builtinsDir(): string {
  // packaged desktop app sets this (resources path); dev/CLI use the repo dir
  return process.env.DHRUVA_WORKFLOWS_DIR ?? path.join(process.cwd(), "workflows");
}

let cache: Record<string, WorkflowDef> | null = null;

export async function builtinWorkflows(): Promise<Record<string, WorkflowDef>> {
  // cache in production; re-read in dev so workflow-file edits hot-reload
  if (cache && process.env.NODE_ENV === "production") return cache;
  const out: Record<string, WorkflowDef> = {};
  let files: string[] = [];
  try {
    files = (await fs.readdir(builtinsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    throw new Error(
      `built-in workflows folder not found at ${builtinsDir()} — broken install (set DHRUVA_WORKFLOWS_DIR or run from the repo root)`,
    );
  }
  for (const f of files.sort()) {
    const raw = JSON.parse(await fs.readFile(path.join(builtinsDir(), f), "utf8"));
    // a broken shipped file must fail LOUDLY, never be served silently
    const def = validateWorkflowDef(raw);
    out[def.id] = def;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`no built-in workflows found in ${builtinsDir()}`);
  }
  cache = out;
  return out;
}
