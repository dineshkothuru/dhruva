import path from "node:path";
import { promises as fs } from "node:fs";
import type { StepDef, WorkflowDef } from "./schema";
import { WORKFLOWS } from "./builtins";
import { checkWorkflowSemantics } from "./validate";

/** Custom workflows — user-designed in the UI, stored per project as
 * .sfharness/workflows/<id>.json in the SAME shape as built-ins, so the
 * engine runs them identically (gates, agents, verify, tiers, revisions). */

const STEP_TYPES = new Set([
  "snapshot",
  "agent",
  "cli",
  "gate",
  "changes",
  "verify",
  "tasks-check",
]);
const TIERS = new Set(["best", "default", "light"]);
const ROLES = new Set(["read", "design", "implement", "review", "trace"]);
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

function dirOf(root: string) {
  return path.join(root, ".sfharness", "workflows");
}

/** Validate an untrusted definition into a clean WorkflowDef (or throw). */
export function validateWorkflowDef(raw: unknown): WorkflowDef {
  const d = raw as Partial<WorkflowDef>;
  if (!d || typeof d !== "object") throw new Error("definition must be an object");
  if (typeof d.id !== "string" || !SLUG.test(d.id)) {
    throw new Error("id must be a lowercase slug (a-z, 0-9, dashes)");
  }
  if (WORKFLOWS[d.id]) throw new Error(`id "${d.id}" collides with a built-in workflow`);
  if (typeof d.title !== "string" || !d.title.trim() || d.title.length > 80) {
    throw new Error("title required (max 80 chars)");
  }
  const description =
    typeof d.description === "string" ? d.description.slice(0, 300) : "";

  const inputs = (Array.isArray(d.inputs) ? d.inputs : []).slice(0, 10).map((i) => {
    if (!i || typeof i.key !== "string" || !KEY.test(i.key)) throw new Error("bad input key");
    const kind: "text" | "boolean" | "select" =
      i.kind === "boolean" || i.kind === "select" ? i.kind : "text";
    return {
      key: i.key,
      label: typeof i.label === "string" ? i.label.slice(0, 120) : i.key,
      kind,
      options:
        kind === "select" && Array.isArray(i.options)
          ? i.options.filter((o) => typeof o === "string").slice(0, 12)
          : undefined,
      default:
        typeof i.default === "boolean" || typeof i.default === "string" ? i.default : undefined,
    };
  });

  if (!Array.isArray(d.steps) || d.steps.length === 0 || d.steps.length > 30) {
    throw new Error("1–30 steps required");
  }
  const seen = new Set<string>();
  const steps: StepDef[] = d.steps.map((s) => {
    if (!s || typeof s.id !== "string" || !SLUG.test(s.id)) throw new Error("bad step id");
    if (seen.has(s.id)) throw new Error(`duplicate step id "${s.id}"`);
    seen.add(s.id);
    if (typeof s.type !== "string" || !STEP_TYPES.has(s.type)) {
      throw new Error(`bad step type on "${s.id}"`);
    }
    const step: StepDef = {
      id: s.id,
      title: typeof s.title === "string" && s.title.trim() ? s.title.slice(0, 120) : s.id,
      type: s.type as StepDef["type"],
    };
    if (s.type === "agent") {
      if (typeof s.prompt !== "string" || !s.prompt.trim()) {
        throw new Error(`agent step "${s.id}" needs a prompt`);
      }
      step.prompt = s.prompt.slice(0, 8000);
      if (s.readOnly === true) step.readOnly = true;
      if (typeof s.persona === "string" && SLUG.test(s.persona)) step.persona = s.persona;
      if (typeof s.modelTier === "string" && TIERS.has(s.modelTier)) {
        step.modelTier = s.modelTier as StepDef["modelTier"];
      }
      if (typeof s.role === "string" && ROLES.has(s.role)) {
        step.role = s.role as StepDef["role"];
      }
      if (s.autoRevise && typeof s.autoRevise === "object") {
        const a = s.autoRevise as { target?: unknown; trigger?: unknown; maxRounds?: unknown };
        if (
          typeof a.target === "string" &&
          SLUG.test(a.target) &&
          typeof a.trigger === "string" &&
          a.trigger.length <= 200
        ) {
          step.autoRevise = {
            target: a.target,
            trigger: a.trigger,
            maxRounds:
              typeof a.maxRounds === "number" ? Math.min(Math.max(a.maxRounds, 1), 3) : undefined,
          };
        }
      }
      if (s.taskLoop === true) step.taskLoop = true;
    }
    if (typeof s.timeoutMinutes === "number") {
      step.timeoutMinutes = Math.min(Math.max(Math.round(s.timeoutMinutes), 1), 120);
    }
    if (typeof s.tasksFile === "string" && s.tasksFile.length <= 200 && !s.tasksFile.includes("..")) {
      step.tasksFile = s.tasksFile;
    }
    if (s.type === "cli") {
      if (s.bin !== "sf" && s.bin !== "git") throw new Error(`cli step "${s.id}": bin must be sf or git`);
      if (!Array.isArray(s.args) || s.args.length === 0 || s.args.length > 40) {
        throw new Error(`cli step "${s.id}" needs 1–40 args`);
      }
      step.bin = s.bin;
      step.args = s.args.map((a) => {
        if (typeof a !== "string" || a.length > 300) throw new Error("bad cli arg");
        return a;
      });
      if (s.optional === true) step.optional = true;
    }
    if (s.type === "gate") {
      step.message =
        typeof s.message === "string" && s.message.trim() ? s.message.slice(0, 1000) : "Proceed?";
      if (typeof s.reviseTarget === "string" && SLUG.test(s.reviseTarget)) {
        step.reviseTarget = s.reviseTarget;
      }
    }
    if (typeof s.onlyIf === "string" && KEY.test(s.onlyIf)) step.onlyIf = s.onlyIf;
    return step;
  });

  const def: WorkflowDef = { id: d.id, title: d.title.trim(), description, inputs, steps };
  // Deterministic semantic checks: every reference must resolve, every step
  // must have its producers earlier, real deploys must be gated.
  const problems = checkWorkflowSemantics(def);
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
  return def;
}

export async function listCustomWorkflows(root: string): Promise<WorkflowDef[]> {
  const out: WorkflowDef[] = [];
  try {
    for (const f of await fs.readdir(dirOf(root))) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dirOf(root), f), "utf8"));
        out.push(validateWorkflowDef(raw));
      } catch {
        /* invalid file — skip; the save path validates, so this is rare */
      }
    }
  } catch {
    /* no custom dir yet */
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export async function loadWorkflow(root: string, id: string): Promise<WorkflowDef | null> {
  if (WORKFLOWS[id]) return WORKFLOWS[id];
  if (!SLUG.test(id)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dirOf(root), `${id}.json`), "utf8"));
    return validateWorkflowDef(raw);
  } catch {
    return null;
  }
}

export async function saveCustomWorkflow(root: string, raw: unknown): Promise<WorkflowDef> {
  const def = validateWorkflowDef(raw);
  await fs.mkdir(dirOf(root), { recursive: true });
  await fs.writeFile(path.join(dirOf(root), `${def.id}.json`), JSON.stringify(def, null, 2), "utf8");
  return def;
}

export async function deleteCustomWorkflow(root: string, id: string): Promise<boolean> {
  if (!SLUG.test(id) || WORKFLOWS[id]) return false;
  try {
    await fs.unlink(path.join(dirOf(root), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
