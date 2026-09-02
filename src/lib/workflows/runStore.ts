import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { GateDecision, RunState } from "./schema";

/** The run registry and its persistence - the engine's shared mutable state,
 * extracted so exactly one module owns the maps and the audit writes. Runs
 * live in this server process (a local single-user tool); every state change
 * is persisted to <project>/.dhruva/runs/<runId>.json - the audit trail. */

export const runs = new Map<string, RunState>();
export const gateWaiters = new Map<string, (decision: GateDecision) => void>(); // key: runId
// the live child process of each run's current step - so an abort can kill it
export const activeChildren = new Map<string, ReturnType<typeof spawn>>();

export function getRun(runId: string): RunState | undefined {
  return runs.get(runId);
}

/** Roots compare case-insensitively on win32: the same project attached as
 * D:\proj and d:\proj must count as ONE project, or the one-run guard has a
 * hole exactly the width of a lowercase drive letter. */
export function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Is a run currently active (running or parked at a gate) for this project?
 * The chat route checks this before re-baselining the shared snapshot store. */
export function hasActiveRun(root: string): boolean {
  for (const r of runs.values()) {
    if (sameRoot(r.root, root) && (r.status === "running" || r.status === "waiting_gate")) return true;
  }
  return false;
}

/** Live runs for this project waiting on a human gate (in-memory only -
 * cheap enough to poll for the tab-bar indicator). */
export function pendingGateCount(root: string): number {
  let n = 0;
  for (const r of runs.values()) {
    if (sameRoot(r.root, root) && r.status === "waiting_gate") n++;
  }
  return n;
}

/** Recent runs for a project: in-memory (live) runs merged with the audit
 * files on disk, so history survives server restarts. A disk run still
 * marked running belongs to a dead server process → shown as aborted. */
export async function listRuns(root: string): Promise<RunState[]> {
  const byId = new Map<string, RunState>();
  const dir = path.join(root, ".dhruva", "runs");
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as RunState;
        if (!r.runId || !Array.isArray(r.steps)) continue;
        if (r.status === "running" || r.status === "waiting_gate") {
          r.status = "aborted";
          // normalize the steps too - a step frozen at "running" in a dead
          // run's audit must not render as working forever, and the reader
          // deserves to know WHY the run ended
          for (const s of r.steps) {
            if (s.status === "running" || s.status === "waiting_gate") {
              s.status = "failed";
              s.endedAt ??= Date.now();
              s.output +=
                "\n[engine] run ended while this step was in progress - the server process " +
                "restarted or was killed (dev-mode file edits recompile the app; the installed " +
                "desktop app is immune). Output above is the last saved state; re-run the workflow.";
            }
          }
        }
        byId.set(r.runId, r);
      } catch {
        /* corrupt audit file - skip */
      }
    }
  } catch {
    /* no runs dir yet */
  }
  for (const r of runs.values()) {
    if (r.root === root) byId.set(r.runId, r); // live state wins over disk
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

/** User-requested stop of a live run: resolves a waiting gate as an abort,
 * or kills the running step's process tree. The executor loop sees the
 * aborted status and skips every remaining step. */
export function abortRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || (run.status !== "running" && run.status !== "waiting_gate")) return false;
  run.status = "aborted";
  if (resolveGate(runId, { action: "abort" })) return true; // parked at a gate
  const step = run.steps.find((s) => s.status === "running");
  if (step) {
    // mark immediately - the UI must never show "working" on an aborted run,
    // even if the process tree takes time to die
    step.status = "failed";
    step.endedAt = Date.now();
    step.output += "\n[engine] aborted by user (Stop run) - the step's process was killed";
  }
  const child = activeChildren.get(runId);
  if (child?.pid) {
    // shell:true means the child is cmd.exe - kill the whole tree
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
    child.kill();
  }
  void persist(run);
  return true;
}

export function resolveGate(runId: string, decision: GateDecision): boolean {
  const waiter = gateWaiters.get(runId);
  if (!waiter) return false;
  gateWaiters.delete(runId);
  waiter(decision);
  return true;
}

let persistChain = Promise.resolve();

/** Debounce window for the streaming hot path. */
const PERSIST_DEBOUNCE_MS = 250;
const pendingPersist = new Map<string, ReturnType<typeof setTimeout>>();

/** Audit write for the STREAMING path.
 *
 * persist() rewrites the entire run as pretty-printed json, and a step's stdout
 * arrives as hundreds of small chunks, so writing on every chunk costs O(n^2)
 * in the output size. That was survivable only because the output was capped at
 * 60k; with the cap raised to a runaway backstop it is not. Coalesce the chunk
 * writes and let the boundaries - step end, gate, status change - call persist()
 * directly, which also cancels anything pending here. */
/** Rough size of each run's last serialized audit json - big runs (a 30k-file
 * retrieve's change list rides in every write) debounce longer, because the
 * cost of the streaming path is stringify-bytes × writes-per-second. */
const lastSize = new Map<string, number>();

export function persistSoon(run: RunState) {
  if (pendingPersist.has(run.runId)) return;
  const delay = (lastSize.get(run.runId) ?? 0) > 2_000_000 ? 1_000 : PERSIST_DEBOUNCE_MS;
  pendingPersist.set(
    run.runId,
    setTimeout(() => {
      pendingPersist.delete(run.runId);
      void persist(run);
    }, delay),
  );
}

export async function persist(run: RunState) {
  // a forced write supersedes any coalesced one still waiting
  const queued = pendingPersist.get(run.runId);
  if (queued) {
    clearTimeout(queued);
    pendingPersist.delete(run.runId);
  }
  // serialize writes; audit file lives with the project
  persistChain = persistChain.then(async () => {
    try {
      const dir = path.join(run.root, ".dhruva", "runs");
      await fs.mkdir(dir, { recursive: true });
      // write-then-rename: this file is rewritten every 250ms while a step
      // streams, so an in-place write killed mid-stream left truncated JSON -
      // and the run live at crash time is exactly the one whose audit matters
      const file = path.join(dir, `${run.runId}.json`);
      const json = JSON.stringify(run, null, 2);
      lastSize.set(run.runId, json.length);
      await fs.writeFile(`${file}.tmp`, json, "utf8");
      await fs.rename(`${file}.tmp`, file);
    } catch {
      /* audit persistence is best-effort */
    }
  });
  await persistChain;
}
