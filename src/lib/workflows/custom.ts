import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
 *  - "project": <project>/.dhruva/workflows - travels with the repo, so
 *    teammates who clone the project get it too.
 *
 * Trust boundary: a project-scope file ships WITH the attached repo, which
 * makes it attacker-authored until a human approves it. Two rules enforce
 * that:
 *  - On an id collision the USER's central copy wins - a repo must never
 *    silently replace a workflow name the user already trusts.
 *  - A project-scope workflow only RUNS after the user has saved it from
 *    this app (which records the file's hash in the user's home config,
 *    where the repo cannot write). A file that appeared from a clone, or
 *    changed since it was approved, is listed for review but refused at
 *    start until re-saved. */

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
  return path.join(root, ".dhruva", "workflows");
}
function dirFor(root: string, scope: WorkflowScope) {
  return scope === "project" ? projectDir(root) : centralDir();
}

/** Approved project-workflow hashes, in the USER's config dir - the one place
 * the attached repo (and the agents running inside it) cannot write. */
function trustFile() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfg, "dhruva", "trusted-project-workflows.json");
}
function normRoot(root: string) {
  const r = path.resolve(root);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
function hashOf(rawJson: string) {
  return createHash("sha256").update(rawJson).digest("hex");
}
async function readTrust(): Promise<Record<string, string>> {
  try {
    const t = JSON.parse(await fs.readFile(trustFile(), "utf8"));
    return t && typeof t === "object" ? (t as Record<string, string>) : {};
  } catch {
    return {};
  }
}
async function recordProjectTrust(root: string, id: string, rawJson: string): Promise<void> {
  const t = await readTrust();
  t[`${normRoot(root)}::${id}`] = hashOf(rawJson);
  await fs.mkdir(path.dirname(trustFile()), { recursive: true });
  await fs.writeFile(trustFile(), JSON.stringify(t, null, 2), "utf8");
}
async function isTrustedProject(root: string, id: string, rawJson: string): Promise<boolean> {
  return (await readTrust())[`${normRoot(root)}::${id}`] === hashOf(rawJson);
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
): Promise<{ def: WorkflowDef; scope: WorkflowScope; trusted?: boolean }[]> {
  const byId = new Map<string, { def: WorkflowDef; scope: WorkflowScope; trusted?: boolean }>();
  // Project entries first, so the user's central copies WIN id collisions -
  // a repo must not shadow a workflow name the user already trusts.
  try {
    for (const f of await fs.readdir(projectDir(root))) {
      if (!f.endsWith(".json")) continue;
      try {
        const rawJson = await fs.readFile(path.join(projectDir(root), f), "utf8");
        const def = validateWorkflowDef(JSON.parse(rawJson));
        byId.set(def.id, {
          def,
          scope: "project",
          trusted: await isTrustedProject(root, def.id, rawJson),
        });
      } catch {
        /* invalid file - skip */
      }
    }
  } catch {
    /* no project dir yet */
  }
  for (const def of await readDir(legacyCentralDir())) byId.set(def.id, { def, scope: "central" });
  for (const def of await readDir(centralDir())) byId.set(def.id, { def, scope: "central" });
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
  const json = JSON.stringify(def, null, 2);
  await fs.writeFile(path.join(dir, `${def.id}.json`), json, "utf8");
  // Saving from the app IS the human approval: record the hash so this exact
  // content may run. A later edit by anything else (agent, repo pull)
  // invalidates it until a human saves again.
  if (scope === "project") await recordProjectTrust(root, def.id, json);
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

/** Resolve a workflow id: built-in → central custom → APPROVED project custom.
 * User-owned scopes come first (a repo must not shadow the user's own id),
 * and a project-scope file runs only if its exact content was approved. */
export async function loadWorkflow(root: string, id: string): Promise<WorkflowDef | null> {
  const builtins = await builtinWorkflows();
  if (builtins[id]) return builtins[id];
  if (!SLUG.test(id)) return null;
  for (const dir of [centralDir(), legacyCentralDir()]) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), "utf8"));
      return validateWorkflowDef(raw);
    } catch {
      /* try next scope */
    }
  }
  try {
    const rawJson = await fs.readFile(path.join(projectDir(root), `${id}.json`), "utf8");
    if (!(await isTrustedProject(root, id, rawJson))) return null;
    return validateWorkflowDef(JSON.parse(rawJson));
  } catch {
    return null;
  }
}

/** Why a project workflow won't load: exists but was never approved (or
 * changed since approval). Lets the start route explain instead of "unknown". */
export async function projectWorkflowUntrusted(root: string, id: string): Promise<boolean> {
  if (!SLUG.test(id)) return false;
  try {
    const rawJson = await fs.readFile(path.join(projectDir(root), `${id}.json`), "utf8");
    return !(await isTrustedProject(root, id, rawJson));
  } catch {
    return false;
  }
}
