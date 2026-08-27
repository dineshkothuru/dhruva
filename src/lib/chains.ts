import type { RunState } from "@/lib/workflows/schema";

/** Chain grouping for the run history.
 *
 * Runs in one chain used to appear as unrelated rows, which made a multi
 * phase delivery impossible to follow: nowhere showed the chain as a whole,
 * its progress, or which phase had stalled.
 *
 * Pulled out of the component so it can be tested without a live chain -
 * synthesising a RunState is cheap, running a real three-phase chain is not. */

/** Every member of a chain carries the same plan, and the FIRST phase's run
 * id is inside every copy of it - so that id identifies the chain. A solo run
 * is its own key. */
export function chainKeyOf(r: RunState): string {
  return r.chain && r.chain.length > 1 ? (r.chain[0]?.runId ?? r.runId) : r.runId;
}

export interface RunGroup {
  key: string;
  /** ordered by phase; a solo run is a group of one */
  runs: RunState[];
}

/** Group history into chains, most recently active first. */
export function groupRunsByChain(runs: RunState[]): RunGroup[] {
  const by = new Map<string, RunState[]>();
  for (const r of runs) {
    const k = chainKeyOf(r);
    const list = by.get(k);
    if (list) list.push(r);
    else by.set(k, [r]);
  }
  return [...by.entries()]
    .map(([key, rs]) => ({
      key,
      runs: [...rs].sort((a, b) => (a.chainIndex ?? 0) - (b.chainIndex ?? 0)),
    }))
    .sort(
      (a, b) =>
        Math.max(...b.runs.map((r) => r.createdAt)) - Math.max(...a.runs.map((r) => r.createdAt)),
    );
}

/** The state of a chain as a whole: live beats broken beats complete. A
 * single failed phase pauses the chain even if earlier phases are done. */
export function chainState(g: RunGroup): string {
  const plan = g.runs[g.runs.length - 1]?.chain;
  if (g.runs.some((r) => r.status === "running" || r.status === "waiting_gate")) return "running";
  const broke = g.runs.find((r) => r.status === "failed" || r.status === "aborted");
  if (broke) return broke.status;
  const chained = !!plan && plan.length > 1;
  if (chained && plan!.every((c) => c.runId) && g.runs.every((r) => r.status === "done")) {
    return "done";
  }
  // A chain with an unstarted link is NOT finished. Nothing is live and
  // nothing broke, so the engine is mid-handoff - reporting "done" here would
  // have told the user a delivery was complete when a phase had yet to run.
  if (chained && plan!.some((c) => !c.runId)) return "running";
  return g.runs[g.runs.length - 1]?.status ?? "done";
}
