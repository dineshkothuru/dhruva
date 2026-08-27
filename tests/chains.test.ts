import { describe, expect, it } from "vitest";
import { chainKeyOf, chainState, groupRunsByChain } from "@/lib/chains";
import type { ChainLink, RunState } from "@/lib/workflows/schema";

const PLAN: ChainLink[] = [
  { workflowId: "solution-design", title: "Solution design", runId: "A" },
  { workflowId: "implement-tdd", title: "Implement from TDD", runId: "B" },
];

const run = (id: string, over: Partial<RunState> = {}): RunState =>
  ({
    runId: id,
    workflowId: "solution-design",
    workflowTitle: "Solution design",
    root: "D:/p",
    createdAt: 1000,
    status: "done",
    agent: "claude",
    inputs: {},
    steps: [],
    ...over,
  }) as RunState;

/** A three-phase chain is expensive to run and cheap to synthesise, so the
 * grouping is tested here rather than by driving a real delivery. */
describe("chainKeyOf", () => {
  it("keys every phase of a chain to the FIRST phase's run id", () => {
    const a = run("A", { chain: PLAN, chainIndex: 0 });
    const b = run("B", { chain: PLAN, chainIndex: 1 });
    expect(chainKeyOf(a)).toBe("A");
    expect(chainKeyOf(b)).toBe("A");
  });

  it("keys a solo run to itself", () => {
    expect(chainKeyOf(run("Z"))).toBe("Z");
  });

  it("keys a one-link chain to itself rather than treating it as a chain", () => {
    const solo = run("Z", { chain: [PLAN[0]], chainIndex: 0 });
    expect(chainKeyOf(solo)).toBe("Z");
  });
});

describe("groupRunsByChain", () => {
  it("collapses a chain's phases into one group", () => {
    const groups = groupRunsByChain([
      run("B", { chain: PLAN, chainIndex: 1, createdAt: 2000 }),
      run("A", { chain: PLAN, chainIndex: 0, createdAt: 1000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((r) => r.runId)).toEqual(["A", "B"]);
  });

  it("keeps solo runs separate", () => {
    const groups = groupRunsByChain([run("X"), run("Y")]);
    expect(groups).toHaveLength(2);
  });

  it("orders phases by position, not by arrival", () => {
    const groups = groupRunsByChain([
      run("B", { chain: PLAN, chainIndex: 1 }),
      run("A", { chain: PLAN, chainIndex: 0 }),
    ]);
    expect(groups[0].runs.map((r) => r.chainIndex)).toEqual([0, 1]);
  });

  it("floats the most recently active chain to the top", () => {
    const groups = groupRunsByChain([
      run("old", { createdAt: 10 }),
      run("A", { chain: PLAN, chainIndex: 0, createdAt: 20 }),
      run("B", { chain: PLAN, chainIndex: 1, createdAt: 99 }),
    ]);
    expect(groups[0].key).toBe("A");
    expect(groups[1].key).toBe("old");
  });
});

describe("chainState", () => {
  const group = (...runs: RunState[]) => ({ key: "A", runs });

  it("is running while any phase is live", () => {
    expect(
      chainState(
        group(
          run("A", { chain: PLAN, chainIndex: 0, status: "done" }),
          run("B", { chain: PLAN, chainIndex: 1, status: "running" }),
        ),
      ),
    ).toBe("running");
  });

  it("treats a gate as live, not stalled", () => {
    expect(
      chainState(group(run("A", { chain: PLAN, chainIndex: 0, status: "waiting_gate" }))),
    ).toBe("running");
  });

  it("reports the failure when a phase broke", () => {
    expect(
      chainState(
        group(
          run("A", { chain: PLAN, chainIndex: 0, status: "done" }),
          run("B", { chain: PLAN, chainIndex: 1, status: "failed" }),
        ),
      ),
    ).toBe("failed");
  });

  it("is done only when EVERY phase started and finished", () => {
    expect(
      chainState(
        group(
          run("A", { chain: PLAN, chainIndex: 0, status: "done" }),
          run("B", { chain: PLAN, chainIndex: 1, status: "done" }),
        ),
      ),
    ).toBe("done");
  });

  it("is not done when a later phase has not started yet", () => {
    const partial: ChainLink[] = [PLAN[0], { ...PLAN[1], runId: undefined }];
    expect(
      chainState(group(run("A", { chain: partial, chainIndex: 0, status: "done" }))),
    ).not.toBe("done");
  });
});
