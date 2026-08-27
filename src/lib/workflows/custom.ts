import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { WorkflowDef } from "./schema";
import { builtinWorkflows } from "./builtins";
import { validateWorkflowDef } from "./validate";

/** Custom workflows - user-designed (usually by duplicating a built-in),
 * stored as JSON in the SAME shape as built-ins and validated by the same
 * contract, so the engine runs them identically.
 *
 * Two scopes:
 *  - "central" (default): ~/.dhruva/workflows - follows the user across every
 *    project they connect on this machine.
 *  - "project": <project>/.sfharness/workflows - travels with the repo, so
 *    teammates who clone the project get it too.
 * On an id collision the project copy wins (more specific). */

export type WorkflowScope = "central" | "project";

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

function centralDir() {
  // XDG-style config home (~/.config/dhruva) - the convention most CLIs use
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfg, "dhruva", "workflows");
}
// pre-rename location - still read (never written) so nothing already saved is lost
function legacyCentralDir() {
  return path.join(os.homedir(), ".dhruva", "workflows");
}
function projectDir(root: string) {
  return path.join(root, ".sfharness", "workflows");
}
function dirFor(root: string, scope: WorkflowScope) {
  return scope === "project" ? projectDir(root) : centralDir();
}

async function readDir(dir: string): Promise<WorkflowDef[]> {
  const out: WorkflowDef[] = [];
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
        out.push(validateWorkflowDef(raw));
      } catch {
        /* invalid file - skip; the save path validates, so this is rare */
      }
    }
  } catch {
    /* dir doesn't exist yet */
  }
  return out;
}

export async function listCustomWorkflows(
  root: string,
): Promise<{ def: WorkflowDef; scope: WorkflowScope }[]> {
  const byId = new Map<string, { def: WorkflowDef; scope: WorkflowScope }>();
  for (const def of await readDir(legacyCentralDir())) byId.set(def.id, { def, scope: "central" });
  for (const def of await readDir(centralDir())) byId.set(def.id, { def, scope: "central" });
  for (const def of await readDir(projectDir(root))) byId.set(def.id, { def, scope: "project" });
  return [...byId.values()].sort((a, b) => a.def.title.localeCompare(b.def.title));
}

export async function saveCustomWorkflow(
  root: string,
  raw: unknown,
  scope: WorkflowScope = "central",
): Promise<WorkflowDef> {
  const reserved = new Set(Object.keys(await builtinWorkflows()));
  const def = validateWorkflowDef(raw, reserved);
  const dir = dirFor(root, scope);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${def.id}.json`), JSON.stringify(def, null, 2), "utf8");
  return def;
}

export async function deleteCustomWorkflow(root: string, id: string): Promise<boolean> {
  if (!SLUG.test(id)) return false;
  let deleted = false;
  for (const dir of [projectDir(root), centralDir(), legacyCentralDir()]) {
    try {
      await fs.unlink(path.join(dir, `${id}.json`));
      deleted = true;
    } catch {
      /* not in this scope */
    }
  }
  return deleted;
}

/** Resolve a workflow id: built-in → project custom → central custom. */
export async function loadWorkflow(root: string, id: string): Promise<WorkflowDef | null> {
  const builtins = await builtinWorkflows();
  if (builtins[id]) return builtins[id];
  if (!SLUG.test(id)) return null;
  for (const dir of [projectDir(root), centralDir(), legacyCentralDir()]) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), "utf8"));
      return validateWorkflowDef(raw);
    } catch {
      /* try next scope */
    }
  }
  return null;
}
