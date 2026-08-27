import { describe, expect, it } from "vitest";
import { renderTranscript } from "@/lib/runTranscript";
import { OUTCOME_END, OUTCOME_START } from "@/lib/outcome";
import type { RunState } from "@/lib/workflows/schema";

const run = (over: Partial<RunState> = {}): RunState =>
  ({
    runId: "r1",
    workflowId: "solution-design",
    workflowTitle: "Solution design",
    root: "D:/p",
    createdAt: 1700000000000,
    status: "done",
    agent: "claude",
    model: "claude-opus-5",
    inputs: { requirement: "build lead scoring", docName: "solution-design" },
    steps: [
      {
        id: "analyse",
        title: "Analyse requirement",
        type: "agent",
        status: "done",
        output: "line one\nline two\nFlow was rejected because publish rules need Apex",
      },
    ],
    ...over,
  }) as RunState;

/** The whole point of the transcript is that it is LINE-ORIENTED: the JSON
 * stores a step as one escaped string, so grepping it returns the entire
 * step. These tests pin the property that makes cheap retrieval possible. */
describe("renderTranscript", () => {
  it("writes step output as real lines, not one escaped blob", () => {
    const md = renderTranscript(run());
    const longest = Math.max(...md.split("\n").map((l) => l.length));
    expect(md).toContain("line one\nline two");
    expect(longest).toBeLessThan(2000);
  });

  it("a grep-sized slice is a fraction of the whole", () => {
    const md = renderTranscript(run());
    const hit = md.split("\n").filter((l) => /Flow was rejected/.test(l));
    expect(hit).toHaveLength(1);
    expect(hit[0].length).toBeLessThan(md.length / 3);
  });

  it("records what the run was asked to do", () => {
    expect(renderTranscript(run())).toContain("requirement: build lead scoring");
  });

  it("keeps the WHY: gate feedback that sent a step back", () => {
    const md = renderTranscript(
      run({ revisions: { analyse: ["portal sharing is not implementable as written"] } }),
    );
    expect(md).toContain("Feedback given at the gate");
    expect(md).toContain("portal sharing is not implementable");
  });

  it("surfaces a step's stated outcome as its own line", () => {
    const md = renderTranscript(
      run({
        steps: [
          {
            id: "analyse",
            title: "Analyse",
            type: "agent",
            status: "done",
            output: `narration\n${OUTCOME_START}\nSUMMARY: designed 17 requirements\nPRODUCED: an ERD\n${OUTCOME_END}`,
          },
        ],
      } as Partial<RunState>),
    );
    expect(md).toContain("outcome: designed 17 requirements");
    expect(md).toContain("produced: an ERD");
  });

  it("names the chain a phase belongs to", () => {
    const md = renderTranscript(
      run({
        chain: [
          { workflowId: "solution-design", title: "Solution design", runId: "r1" },
          { workflowId: "implement-tdd", title: "Implement from TDD" },
        ],
        chainIndex: 0,
      }),
    );
    expect(md).toContain("Solution design -> Implement from TDD");
  });

  it("lists manual steps a human still owes", () => {
    const md = renderTranscript(
      run({ manualSteps: [{ stepId: "write-doc", text: "enable sharing on Event_Profile__c" }] }),
    );
    expect(md).toContain("enable sharing on Event_Profile__c");
  });
});
