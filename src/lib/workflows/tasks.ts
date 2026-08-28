import path from "node:path";
import { promises as fs } from "node:fs";
import { resolveInside } from "@/lib/fsguard";

/** Machine-readable build plan - the contract between Solution design
 * (producer), Implement-from-TDD (consumer, one agent spawn per task), and
 * the code reviewer (which REOPENs specific tasks). JSON, validated
 * deterministically by the engine (structure adapted from
 * ugudlado/workflows' tasks.yaml contract). */

export interface TaskDef {
  /** "T-<n>" (design tasks) or "fix-<n>" (review-created). */
  id: string;
  title: string;
  depends_on?: string[];
  /** Project-relative paths this task is expected to touch. */
  files: string[];
  test_scenarios?: string[];
  /** REQ/AC ids from the design documents this task serves. */
  traces?: string[];
  /** The mechanism - what edit, where. */
  change?: string;
  status?: "pending" | "completed";
  /** Reviewer comments appended when the task is reopened. */
  reviews?: { at: string; comment: string }[];
  /** Written by the implement loop on completion. */
  tokens_in?: number;
  tokens_out?: number;
  duration_s?: number;
}

export interface TasksFile {
  version: 1;
  tasks: TaskDef[];
}

const ID_RE = /^(T|fix)-\d{1,4}$/;
const MAX_TASKS = 60;

/** Validate untrusted JSON into a TasksFile; returns the errors found
 * (empty = valid). Agent-produced, so every field is checked. */
export function validateTasks(raw: unknown): { data: TasksFile | null; errors: string[] } {
  const errors: string[] = [];
  const d = raw as Partial<TasksFile>;
  if (!d || typeof d !== "object") return { data: null, errors: ["tasks file must be a JSON object"] };
  if (d.version !== 1) errors.push('version must be the integer 1');
  if (!Array.isArray(d.tasks) || d.tasks.length === 0 || d.tasks.length > MAX_TASKS) {
    errors.push(`tasks must be a list of 1-${MAX_TASKS} items`);
    return { data: null, errors };
  }
  const ids = new Set<string>();
  const tasks: TaskDef[] = [];
  for (const t of d.tasks as Partial<TaskDef>[]) {
    if (!t || typeof t !== "object") { errors.push("each task must be an object"); continue; }
    const id = typeof t.id === "string" ? t.id : "";
    if (!ID_RE.test(id)) errors.push(`bad task id "${id}" (T-<n> or fix-<n>)`);
    else if (ids.has(id)) errors.push(`duplicate task id "${id}"`);
    ids.add(id);
    if (typeof t.title !== "string" || !t.title.trim()) errors.push(`${id}: title required`);
    if (!Array.isArray(t.files)) errors.push(`${id}: files must be a list`);
    const files = (Array.isArray(t.files) ? t.files : [])
      // Salesforce retrieves routinely produce paths past 260 characters - the
      // shadow repo turns on core.longpaths for exactly that reason - so a
      // length limit here silently drops the deepest metadata files from the
      // task that is supposed to edit them
      .filter((f): f is string => typeof f === "string" && f.length > 0)
      .map((f) => f.replace(/\\/g, "/"));
    for (const f of files) {
      if (f.includes("..") || path.isAbsolute(f)) errors.push(`${id}: file path must be project-relative ("${f}")`);
    }
    tasks.push({
      id,
      title: String(t.title ?? ""),
      depends_on: (Array.isArray(t.depends_on) ? t.depends_on : []).filter(
        (x): x is string => typeof x === "string",
      ),
      files,
      // no cap: a test scenario is an instruction to the implementer, and the
      // tail is where the assertion usually lives
      test_scenarios: (Array.isArray(t.test_scenarios) ? t.test_scenarios : []).filter(
        (x): x is string => typeof x === "string",
      ),
      traces: (Array.isArray(t.traces) ? t.traces : []).filter((x): x is string => typeof x === "string"),
      // no cap: "the mechanism - what edit, where" IS the task's substance,
      // the equivalent of a prompt
      change: typeof t.change === "string" ? t.change : undefined,
      status: t.status === "completed" ? "completed" : "pending",
      reviews: (Array.isArray(t.reviews) ? t.reviews : []).filter(
        (r): r is { at: string; comment: string } =>
          !!r && typeof r === "object" && typeof (r as { comment?: unknown }).comment === "string",
      ),
      tokens_in: typeof t.tokens_in === "number" ? t.tokens_in : undefined,
      tokens_out: typeof t.tokens_out === "number" ? t.tokens_out : undefined,
      duration_s: typeof t.duration_s === "number" ? t.duration_s : undefined,
    });
  }
  // dependencies resolve + no cycles (topo sort over ALL tasks)
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!ids.has(dep)) errors.push(`${t.id}: depends_on "${dep}" does not exist`);
    }
  }
  if (topoOrder(tasks) === null) errors.push("dependency cycle detected");
  return { data: errors.length === 0 ? { version: 1, tasks } : null, errors };
}

/** Kahn topological order over the given tasks; null on a cycle. */
export function topoOrder(tasks: TaskDef[]): TaskDef[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (byId.has(dep)) indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
    }
  }
  // stable: keep file order among ready tasks
  const out: TaskDef[] = [];
  const done = new Set<string>();
  while (out.length < tasks.length) {
    const ready = tasks.find((t) => !done.has(t.id) && (t.depends_on ?? []).every((d) => !byId.has(d) || done.has(d)));
    if (!ready) return null; // cycle
    out.push(ready);
    done.add(ready.id);
  }
  return out;
}

/** Pending tasks in dependency order (a completed dep satisfies the edge). */
export function pendingInOrder(data: TasksFile): TaskDef[] {
  const ordered = topoOrder(data.tasks) ?? data.tasks;
  return ordered.filter((t) => t.status !== "completed");
}

export async function loadTasks(
  root: string,
  rel: string,
): Promise<{ data: TasksFile | null; errors: string[] }> {
  const abs = resolveInside(root, rel);
  if (!abs) return { data: null, errors: ["tasks path escapes the project"] };
  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    return { data: null, errors: [`tasks file not found: ${rel}`] };
  }
  try {
    return validateTasks(JSON.parse(text));
  } catch (e) {
    return { data: null, errors: [`invalid JSON: ${String((e as Error).message).slice(0, 200)}`] };
  }
}

export async function saveTasks(root: string, rel: string, data: TasksFile): Promise<boolean> {
  const abs = resolveInside(root, rel);
  if (!abs) return false;
  try {
    await fs.writeFile(abs, JSON.stringify(data, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Reviewer verdict lines "REOPEN T-3: <comment>" → reopen those tasks with
 * the comment attached. Returns the reopened ids (empty = nothing parsed). */
export async function reopenFromFindings(
  root: string,
  rel: string,
  reviewOutput: string,
): Promise<string[]> {
  // tolerate markdown bold around the marker and comma-separated id lists -
  // models emit "**REOPEN T-3: …**" and "REOPEN T-3, T-4: …" routinely
  const found = [
    ...reviewOutput.matchAll(
      /^[\s*]*REOPEN\s+((?:(?:T|fix)-\d{1,4})(?:\s*,\s*(?:T|fix)-\d{1,4})*)\s*:\s*(.+)$/gim,
    ),
  ];
  if (found.length === 0) return [];
  const { data } = await loadTasks(root, rel);
  if (!data) return [];
  const reopened: string[] = [];
  for (const m of found) {
    const ids = m[1].split(/\s*,\s*/);
    const comment = m[2].trim().replace(/\*+$/, "");
    for (const id of ids) {
      const t = data.tasks.find((x) => x.id === id);
      if (!t) continue;
      t.status = "pending";
      (t.reviews ??= []).push({ at: new Date().toISOString(), comment });
      reopened.push(t.id);
    }
  }
  if (reopened.length > 0) await saveTasks(root, rel, data);
  return reopened;
}
