import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const ENGINE = path.resolve(__dirname, "../src/lib/workflows/engine.ts");
// argv/placeholder expansion was extracted from the engine into its own module
const TEMPLATING = path.resolve(__dirname, "../src/lib/workflows/templating.ts");
const STEPS = path.resolve(__dirname, "../steps");

/** "Create a Student object" on an empty project died at the retrieve step.
 * The design named files that existed neither in the org nor on disk, sf errored
 * on the missing --source-dir, and the run ended before writing any metadata.
 * Nothing about a refresh of not-yet-existing components should be fatal. */
describe("a retrieve cannot ask for what does not exist yet", () => {
  it("only passes affected paths that exist locally", async () => {
    const src = await fs.readFile(TEMPLATING, "utf8");
    const block = src.slice(src.indexOf('a === "{affectedSourceDirs}"'));
    const body = block.slice(0, block.indexOf("} else if"));
    expect(body).toContain("existsSync");
    // and the filter runs BEFORE the empty check, so all-new means "skip"
    expect(body.indexOf("existsSync")).toBeLessThan(body.indexOf("length === 0"));
  });
});

/** A feature-dev run was reported as FAILED having done nothing wrong.
 *
 * "Create a Student object" had already been satisfied by an earlier run, so the
 * implement agent correctly reported PRODUCED: nothing, the change set was
 * empty, and the run then died at "Validate (check-only deploy of changed
 * files)" with "no changed files to act on". Nothing was broken; the run just
 * had nothing to do.
 *
 * The cause was two different situations sharing one branch. `optional` exists
 * to tolerate a command that RAN AND FAILED, and a failed validation must always
 * fail the run. Having nothing to validate is not a failed validation. */
describe("an empty change set is a no-op, not a failure", () => {
  it("skips the step instead of failing it, whether or not it is optional", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const block = src.slice(src.indexOf("const args = expandArgs("));
    const body = block.slice(0, block.indexOf("if (def.detached)"));
    expect(body).toContain('status = "skipped"');
    expect(body).not.toContain("return false");
    // the decision must not consult `optional` - that governs command failure
    const decision = body.slice(0, body.indexOf("return true"));
    expect(decision).not.toContain("def.optional");
  });

  // expandArgs is the reason this is safe: it returns null ONLY for an empty
  // file list, never for a malformed command, so "no args" cannot hide a bug.
  it("relies on expandArgs returning null only for an empty file list", async () => {
    const src = await fs.readFile(TEMPLATING, "utf8");
    const start = src.indexOf("export function expandArgs(");
    expect(start, "expandArgs must exist in templating.ts").toBeGreaterThan(-1);
    const fn = src.slice(start);
    const NL = String.fromCharCode(10);
    const end = fn.indexOf(NL + "export function ", 1);
    const body = end === -1 ? fn : fn.slice(0, end);
    const nulls = [...body.matchAll(/return null;/g)];
    expect(nulls.length, "the empty-list null returns must be present").toBeGreaterThan(0);
    for (const m of nulls) {
      const before = body.slice(Math.max(0, m.index! - 120), m.index!);
      expect(before, "every null return follows an empty-list check").toContain("length === 0");
    }
  });

  // A green run that produced nothing must not read like a successful deploy -
  // that is exactly what made the failure confusing in the first place.
  it("says plainly that a zero-change run produced and deployed nothing", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const block = src.slice(src.indexOf("run.changes = changes;"));
    const body = block.slice(0, block.indexOf("return true"));
    expect(body).toContain("no files changed - nothing was produced by this run");
    expect(body).toMatch(/skipped/);
    expect(body).toMatch(/validated, tested or deployed/);
  });
});

describe("an optional cli step never takes the run down", () => {
  it("tolerates a non-zero exit, not just an empty expansion", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    // the bug: `optional` used to cover only the nothing-to-expand branch
    expect(src).toContain("if (!cliOk && def.optional)");
    expect(src).toMatch(/if \(!cliOk && def\.optional\)[\s\S]{0,400}status = "skipped"/);
  });

  it("tolerates a detached step that cannot launch", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const block = src.slice(src.indexOf("could not launch"));
    expect(block.slice(0, 400)).toContain("def.optional");
  });

  it("marks the steps that are genuinely best-effort", async () => {
    for (const f of ["retrieve-fresh.md", "visual-preview.md"]) {
      const raw = await fs.readFile(path.join(STEPS, f), "utf8");
      expect(raw, f).toContain("optional: true");
    }
  });

  it("leaves the steps that MUST fail the run alone", async () => {
    // a failed deploy or validation is the whole signal - swallowing it would
    // report success on a broken deploy
    for (const f of [
      "deploy.md",
      "bug-fix.validate.md",
      "test-gen.validate.md",
      "validate-deploy.validate.md",
      "validate-tests.md",
      "create.md",
      "push.md",
    ]) {
      const raw = await fs.readFile(path.join(STEPS, f), "utf8");
      expect(raw, `${f} must not be optional`).not.toContain("optional: true");
    }
  });
});
