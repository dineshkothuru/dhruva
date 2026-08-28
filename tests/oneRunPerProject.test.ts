import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const ENGINE = path.resolve(__dirname, "../src/lib/workflows/engine.ts");
const SNAPSHOT = path.resolve(__dirname, "../src/lib/snapshot.ts");
const ROUTE = path.resolve(__dirname, "../src/app/api/workflow/route.ts");

/** One project, one run at a time - and every run measured against its own
 * baseline.
 *
 * The two go together. A project has one working tree and one snapshot store,
 * and neither divides between two runs: their edits land on top of each other,
 * and each run's change list contains the other's files. That list is read by
 * the reviewer, verify-standards and the deploy, so getting it wrong is not
 * cosmetic - a run can review, verify and deploy the wrong file set while
 * reporting success.
 *
 * Pinning each run to its own baseline commit fixes the accounting (proved in
 * concurrentRuns.test.ts). Refusing the second run is what actually makes it
 * safe. These tests hold both in place. */

describe("one run per project", () => {
  it("refuses to start while another run holds the project", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const body = src.slice(src.indexOf("export function startRun("));
    const head = body.slice(0, body.indexOf("const run: RunState = {"));
    expect(head).toContain("hasActiveRun(root)");
    expect(head).toContain("return null");
  });

  // In the engine rather than the route, so a chained next phase and any future
  // caller are covered by the same rule.
  it("guards in the engine, not only at the API boundary", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const startRunIdx = src.indexOf("export function startRun(");
    const guardIdx = src.indexOf("hasActiveRun(root)", startRunIdx);
    expect(guardIdx).toBeGreaterThan(startRunIdx);
    expect(guardIdx).toBeLessThan(src.indexOf("const run: RunState = {", startRunIdx));
  });

  // A chain starts its next phase only after the previous run has finished, so
  // the guard must not stall a chain. If it ever does, the run says why rather
  // than the next phase silently never appearing.
  it("explains a refusal to a chain instead of stalling silently", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const chain = src.slice(src.indexOf("async function fireChain"));
    const block = chain.slice(0, chain.indexOf("async function executeSteps"));
    expect(block).toContain("could not start");
    expect(block).toContain("another run is active");
  });

  it("tells the caller why a start was refused", async () => {
    const src = await fs.readFile(ROUTE, "utf8");
    expect(src).toContain("a run is already active on this project");
    expect(src).toContain("409");
  });
});

describe("every run is measured against its own snapshot", () => {
  it("lets a caller name the baseline to diff against", async () => {
    const src = await fs.readFile(SNAPSHOT, "utf8");
    const fn = src.slice(src.indexOf("export async function changesSince("));
    const body = fn.slice(0, fn.indexOf("export async function baselineContent"));
    expect(body).toContain("since?: string");
    // and it must verify the repo actually has that commit before trusting it
    expect(body).toContain("cat-file");
  });

  it("has the changes step pass the run's own baseline", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    expect(src).toContain("changesSince(run.root, run.baseCommit)");
  });

  // Undo defaults to the change list's own reference point. Restoring to a
  // different commit than the list was measured against would either leave
  // reported changes in place or revert work the run never touched.
  it("has undo default to the same run baseline the change list uses", async () => {
    const src = await fs.readFile(ROUTE, "utf8");
    const block = src.slice(src.indexOf('b.action === "restore"'));
    const body = block.slice(0, block.indexOf('b.action === "resume"'));
    expect(body).toContain("run.baseCommit");
    expect(body).toContain("restoreFiles(root, commit, files)");
    // the default is the narrower, less destructive scope
    expect(body).toContain('const wholeRun = b.scope === "run"');
    // and only for a run that has finished badly
    expect(body).toContain('run.status !== "failed"');
    expect(body).toContain('run.status !== "aborted"');
  });

  // A rebaseline deliberately moves baseCommit after an org refresh, so one
  // field cannot also hold the run's true starting state. It used to try, and
  // after a rebaseline the pre-run state was simply gone.
  it("keeps the run's starting state separately from the moving diff base", async () => {
    const engine = await fs.readFile(ENGINE, "utf8");
    const block = engine.slice(engine.indexOf('case "snapshot": {'));
    const body = block.slice(0, block.indexOf('case "changes": {'));
    // recorded once, never overwritten by a later rebaseline
    expect(body).toContain("run.startCommit ??= run.baseCommit");

    const route = await fs.readFile(ROUTE, "utf8");
    const restore = route.slice(route.indexOf('b.action === "restore"'));
    expect(restore.slice(0, restore.indexOf('b.action === "resume"'))).toContain(
      "run.startCommit",
    );
  });
});

/** A chain is one piece of work in several phases, so it has one "before".
 *
 * Phase 2's own snapshot would commit everything phase 1 produced, making that
 * work part of the baseline and therefore invisible: a design -> implement chain
 * would account for the implementation only, and the documents the design phase
 * wrote would disappear from the chain's record of itself. */
describe("a chained phase inherits the baseline", () => {
  it("hands the finishing phase's commits to the next one", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    expect(src).toContain("inherit?: { baseCommit?: string; startCommit?: string }");
    const chain = src.slice(src.indexOf("async function fireChain"));
    const call = chain.slice(chain.indexOf("startRun("), chain.indexOf("if (next)"));
    expect(call).toContain("baseCommit: run.baseCommit");
    // the chain's original "before" survives every phase, so undo on phase 3
    // can still reach the state before phase 1
    expect(call).toContain("startCommit");
  });

  it("skips the opening snapshot when a baseline was inherited", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const block = src.slice(src.indexOf('case "snapshot": {'));
    const body = block.slice(0, block.indexOf('case "changes": {'));
    expect(body).toContain("chainIndex");
    expect(body).toContain('status = "skipped"');
  });

  // A rebaseline mid-phase is a deliberate "the org refresh is not our change"
  // and must still move the baseline - only the FIRST snapshot is skipped.
  it("still allows a later rebaseline in the same phase", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const block = src.slice(src.indexOf('case "snapshot": {'));
    const body = block.slice(0, block.indexOf('case "changes": {'));
    expect(body).toContain("first");
    expect(body).toContain("takeSnapshot(run.root)");
  });
});
