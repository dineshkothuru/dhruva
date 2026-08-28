import { describe, expect, it } from "vitest";
import { stepRows } from "@/components/workflows/WorkflowsPane";
import type { RunState, StepState } from "@/lib/workflows/schema";

const step = (over: Partial<StepState> = {}): StepState => ({
  id: "analyse",
  title: "Design per requirement",
  type: "agent",
  status: "done",
  output: "current",
  ...over,
});

const run = (steps: StepState[]) => ({ steps }) as unknown as RunState;

/** A step that ran three times used to render as ONE row, with every earlier
 * version overwritten - the audit showed that a design had been reworked but
 * not what any round of it said. */
describe("run history shows one row per execution", () => {
  it("gives a step that ran once a single row", () => {
    const rows = stepRows(run([step()]));
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptsTotal).toBe(1);
    expect(rows[0].rowKey).toBe("analyse");
  });

  it("gives a step that ran three times three rows, oldest first", () => {
    const rows = stepRows(
      run([
        step({
          output: "v3",
          attempts: [
            { output: "v1", status: "done", supersededBy: "auto-revise round 1" },
            { output: "v2", status: "done", supersededBy: "auto-revise round 2" },
          ],
        }),
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.output)).toEqual(["v1", "v2", "v3"]);
    expect(rows.map((r) => r.attemptNo)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.attemptsTotal === 3)).toBe(true);
  });

  it("keeps each row's own status, timings and supersede reason", () => {
    const rows = stepRows(
      run([
        step({
          status: "done",
          attempts: [
            { output: "v1", status: "failed", startedAt: 100, endedAt: 200, supersededBy: "gate revision 1" },
          ],
        }),
      ]),
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].startedAt).toBe(100);
    expect(rows[0].supersededBy).toBe("gate revision 1");
    // the CURRENT row is the live one and was superseded by nothing
    expect(rows[1].status).toBe("done");
    expect(rows[1].supersededBy).toBeUndefined();
  });

  it("gives every row a distinct react key", () => {
    const rows = stepRows(
      run([
        step({ attempts: [{ output: "a", status: "done" }, { output: "b", status: "done" }] }),
        step({ id: "design-review", title: "Review" }),
      ]),
    );
    expect(new Set(rows.map((r) => r.rowKey)).size).toBe(rows.length);
  });

  it("leaves steps that never re-ran untouched", () => {
    const rows = stepRows(run([step({ id: "snapshot" }), step({ id: "context" })]));
    expect(rows.map((r) => r.id)).toEqual(["snapshot", "context"]);
  });
});
