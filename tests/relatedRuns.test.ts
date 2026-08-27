import { describe, expect, it } from "vitest";
import { findRelatedRuns } from "@/lib/relatedRuns";
import type { RunState } from "@/lib/workflows/schema";

const run = (id: string, requirement: string, over: Partial<RunState> = {}): RunState =>
  ({
    runId: id,
    workflowId: "solution-design",
    workflowTitle: "Solution design",
    root: "D:/p",
    createdAt: 1000,
    status: "done",
    agent: "claude",
    inputs: { requirement },
    steps: [],
    ...over,
  }) as RunState;

/** A weak suggestion is worse than none - it teaches people to ignore the
 * panel - so these tests pin the threshold as much as the matching. */
describe("findRelatedRuns", () => {
  const history = [
    run("r1", "Build a lead scoring engine that ranks open leads by engagement nightly"),
    run("r2", "Fix the billing rollup on renewal opportunities"),
    run("r3", "Migrate legacy contact records into the new schema"),
  ];

  it("finds the earlier run that already covered this request", () => {
    const hits = findRelatedRuns("design a lead scoring engine for open leads", history);
    expect(hits[0].runId).toBe("r1");
  });

  it("explains itself with the terms that matched", () => {
    const hits = findRelatedRuns("lead scoring engine for open leads", history);
    expect(hits[0].shared).toEqual(expect.arrayContaining(["lead", "scoring", "engine"]));
  });

  it("stays quiet on an unrelated request", () => {
    expect(findRelatedRuns("what is the API version of this org?", history)).toEqual([]);
  });

  it("is not fooled by common filler words alone", () => {
    expect(findRelatedRuns("please can you make the new thing for us", history)).toEqual([]);
  });

  it("ignores a request too short to judge", () => {
    expect(findRelatedRuns("leads", history)).toEqual([]);
  });

  it("returns nothing when there is no history", () => {
    expect(findRelatedRuns("lead scoring engine open leads", [])).toEqual([]);
  });

  it("surfaces the strongest overlap first", () => {
    const hits = findRelatedRuns(
      "lead scoring engine ranks open leads engagement nightly billing renewal",
      history,
    );
    expect(hits[0].runId).toBe("r1");
  });

  it("caps how many it suggests", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      run(`x${i}`, "lead scoring engine open leads engagement"),
    );
    expect(findRelatedRuns("lead scoring engine open leads engagement", many)).toHaveLength(3);
  });

  it("reports the run's status so a failed attempt is not mistaken for done work", () => {
    const hits = findRelatedRuns("lead scoring engine open leads", [
      run("r9", "lead scoring engine open leads", { status: "failed" }),
    ]);
    expect(hits[0].status).toBe("failed");
  });
});
