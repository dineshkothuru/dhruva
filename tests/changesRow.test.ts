import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const TRACE = path.resolve(__dirname, "../src/components/workflows/StepTrace.tsx");
const ENGINE = path.resolve(__dirname, "../src/lib/workflows/engine.ts");

/** implement-tdd has TWO changes-type steps: retrieve-delta (the org-drift
 * report) and changes (what the run itself wrote). Each overwrites
 * run.changes, so the run view can only show one of them - and StepBody used
 * to return null for the type, which left retrieve-delta as a row that would
 * not open at all. On a real run it was hiding 15,373 characters. */
describe("a changes step renders its own file list", () => {
  it("no longer returns null when there are changed files", async () => {
    const src = await fs.readFile(TRACE, "utf8");
    const branch = src.slice(src.indexOf('if (type === "changes"'));
    const body = branch.slice(0, branch.indexOf("\n  }"));
    expect(body).toContain("no files changed");
    // the old behaviour: a bare `return null` for the has-changes case
    expect(body).not.toMatch(/\n\s*return null;/);
  });

  it("parses the status/path lines the engine writes", async () => {
    const src = await fs.readFile(TRACE, "utf8");
    expect(src).toContain("(modified|added|deleted)");
    // and the engine really does write that shape
    const engine = await fs.readFile(ENGINE, "utf8");
    expect(engine).toContain("`${c.status.padEnd(8)} ${c.file}`");
  });

  it("opens each file against the commit the step diffed against", async () => {
    const src = await fs.readFile(TRACE, "utf8");
    expect(src).toContain("onOpenDiff(c.file, { base: baseCommit })");
  });

  it("pins that commit before anything can move HEAD past it", async () => {
    const engine = await fs.readFile(ENGINE, "utf8");
    const branch = engine.slice(engine.indexOf('case "changes": {'));
    const body = branch.slice(0, branch.indexOf("return true;"));
    // recorded BEFORE changesSince, and before the rebaseline step commits
    expect(body.indexOf("step.baseCommit")).toBeLessThan(body.indexOf("changesSince"));
  });

  it("still falls back to raw text if the shape is not recognised", async () => {
    const src = await fs.readFile(TRACE, "utf8");
    const branch = src.slice(src.indexOf('if (type === "changes"'));
    expect(branch.slice(0, 2000)).toContain("files.length === 0");
  });
});
