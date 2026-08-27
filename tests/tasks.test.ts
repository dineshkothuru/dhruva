import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pendingInOrder, reopenFromFindings, topoOrder, validateTasks } from "@/lib/workflows/tasks";

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `title ${id}`,
  files: ["force-app/main/default/classes/A.cls"],
  depends_on: [],
  ...extra,
});

/** tasks.json is the contract between the design phase and the build loop.
 * A malformed or cyclic file must be rejected by CODE before an agent
 * spends a single token acting on it. */
describe("validateTasks", () => {
  it("accepts a well-formed file", () => {
    const { data, errors } = validateTasks({ version: 1, tasks: [task("T-1")] });
    expect(errors).toEqual([]);
    expect(data?.tasks[0].status).toBe("pending");
  });

  it("rejects a non-object", () => {
    expect(validateTasks("nope").data).toBeNull();
  });

  it("rejects a wrong version", () => {
    const { errors } = validateTasks({ version: 2, tasks: [task("T-1")] });
    expect(errors.join(" ")).toContain("version");
  });

  it("rejects a bad task id", () => {
    const { errors } = validateTasks({ version: 1, tasks: [task("nope-1")] });
    expect(errors.join(" ")).toContain("bad task id");
  });

  it("rejects duplicate ids", () => {
    const { errors } = validateTasks({ version: 1, tasks: [task("T-1"), task("T-1")] });
    expect(errors.join(" ")).toContain("duplicate");
  });

  it("rejects a dependency that does not exist", () => {
    const { errors } = validateTasks({ version: 1, tasks: [task("T-1", { depends_on: ["T-9"] })] });
    expect(errors.join(" ")).toContain("does not exist");
  });

  it("rejects a dependency cycle", () => {
    const { errors } = validateTasks({
      version: 1,
      tasks: [task("T-1", { depends_on: ["T-2"] }), task("T-2", { depends_on: ["T-1"] })],
    });
    expect(errors.join(" ")).toContain("cycle");
  });

  it("refuses paths that escape the project", () => {
    const { errors } = validateTasks({ version: 1, tasks: [task("T-1", { files: ["../../etc/passwd"] })] });
    expect(errors.join(" ")).toContain("project-relative");
  });
});

describe("topoOrder / pendingInOrder", () => {
  it("orders dependants after their dependencies", () => {
    const tasks = [task("T-2", { depends_on: ["T-1"] }), task("T-1")];
    const { data } = validateTasks({ version: 1, tasks });
    const ids = topoOrder(data!.tasks)!.map((t) => t.id);
    expect(ids).toEqual(["T-1", "T-2"]);
  });

  it("returns null on a cycle", () => {
    expect(topoOrder([
      { ...task("T-1", { depends_on: ["T-2"] }) },
      { ...task("T-2", { depends_on: ["T-1"] }) },
    ] as never)).toBeNull();
  });

  it("skips completed tasks but keeps dependency order", () => {
    const { data } = validateTasks({
      version: 1,
      tasks: [task("T-1", { status: "completed" }), task("T-2", { depends_on: ["T-1"] })],
    });
    expect(pendingInOrder(data!).map((t) => t.id)).toEqual(["T-2"]);
  });
});

describe("reopenFromFindings", () => {
  let root: string;
  const rel = "tasks.json";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dhruva-tasks-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const seed = async () =>
    fs.writeFile(
      path.join(root, rel),
      JSON.stringify({
        version: 1,
        tasks: [
          task("T-1", { status: "completed" }),
          task("T-2", { status: "completed" }),
          task("T-3", { status: "completed" }),
        ],
      }),
    );

  it("reopens a task named in a REOPEN line", async () => {
    await seed();
    expect(await reopenFromFindings(root, rel, "REOPEN T-2: the null check is missing")).toEqual(["T-2"]);
    const after = JSON.parse(await fs.readFile(path.join(root, rel), "utf8"));
    const t2 = after.tasks.find((t: { id: string }) => t.id === "T-2");
    expect(t2.status).toBe("pending");
    expect(t2.reviews[0].comment).toContain("null check");
  });

  it("tolerates markdown bold and comma-separated id lists", async () => {
    await seed();
    expect(await reopenFromFindings(root, rel, "**REOPEN T-1, T-3: rework both**")).toEqual(["T-1", "T-3"]);
  });

  it("returns nothing when the review has no REOPEN lines", async () => {
    await seed();
    expect(await reopenFromFindings(root, rel, "VERDICT: APPROVED")).toEqual([]);
  });

  it("ignores REOPEN for an unknown task id", async () => {
    await seed();
    expect(await reopenFromFindings(root, rel, "REOPEN T-99: does not exist")).toEqual([]);
  });
});
