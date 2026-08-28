import { describe, expect, it, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinWorkflows } from "@/lib/workflows/builtins";
import { parseFrontmatter, resolveStep, stepFromFile, isStepRef } from "@/lib/workflows/steps";
import golden from "./fixtures/workflows-golden.json";

const ROOT = path.resolve(__dirname, "..");

beforeAll(() => {
  process.env.DHRUVA_STEPS_DIR = path.join(ROOT, "steps");
  process.env.DHRUVA_WORKFLOWS_DIR = path.join(ROOT, "workflows");
});

/** The fixture is the agreed resolved output of every shipped workflow: what
 * the engine actually runs after the step library is resolved.
 *
 * It was first captured BEFORE the library existed and proved the extraction
 * changed nothing - 94 inline definitions became library files referenced by 11
 * workflows with byte-identical results. It has been re-baselined twice since,
 * both times deliberately: for the design-artifact change to `analyse` and
 * `design-review`, and for the work-check step added to every design phase
 * (4 new steps, plus `emits: work` on `spec`, `locate` and `plan`; every prompt
 * byte-identical, which is what the diff was read for before accepting it).
 *
 * From here it guards against accidental drift: edit a step file and this test
 * tells you exactly which workflow, step and field moved. Re-baseline only when
 * the change was intended. */
describe("the step library resolves to the agreed definitions", () => {
  it("every shipped workflow matches the fixture", async () => {
    const now = await builtinWorkflows();
    const before = golden as unknown as Record<string, unknown>;
    expect(Object.keys(now).sort()).toEqual(Object.keys(before).sort());
    for (const id of Object.keys(before)) {
      expect(now[id], `workflow "${id}" changed`).toEqual(before[id]);
    }
  });

  it("covers all 11 workflows and 98 step instances", async () => {
    const now = await builtinWorkflows();
    expect(Object.keys(now)).toHaveLength(11);
    expect(Object.values(now).reduce((n, d) => n + d.steps.length, 0)).toBe(98);
  });
});

describe("frontmatter parsing", () => {
  it("reads scalars, booleans and numbers", () => {
    const { meta } = parseFrontmatter(`---\nid: analyse\nreadOnly: true\ntimeoutMinutes: 45\n---\nbody`);
    expect(meta).toEqual({ id: "analyse", readOnly: true, timeoutMinutes: 45 });
  });

  it("reads a nested object", () => {
    const { meta } = parseFrontmatter(
      `---\nid: r\nautoRevise:\n  target: analyse\n  trigger: VERDICT\n  maxRounds: 3\n---\n`,
    );
    expect(meta.autoRevise).toEqual({ target: "analyse", trigger: "VERDICT", maxRounds: 3 });
  });

  it("reads a string array", () => {
    const { meta } = parseFrontmatter(`---\nid: c\nbin: sf\nargs:\n  - project\n  - deploy\n---\n`);
    expect(meta.args).toEqual(["project", "deploy"]);
  });

  it("keeps the body verbatim apart from the file's trailing newline", () => {
    const { body } = parseFrontmatter(`---\nid: x\n---\nline one\n\nline three\n`);
    expect(body).toBe("line one\n\nline three");
  });

  it("does not treat a --- inside the body as a fence", () => {
    const { body } = parseFrontmatter(`---\nid: x\n---\nbefore\n---\nafter\n`);
    expect(body).toBe("before\n---\nafter");
  });
});

describe("step files", () => {
  it("puts the body on prompt for an agent step", () => {
    const d = stepFromFile(`---\nid: a\ntype: agent\n---\nDo the thing.`, "a");
    expect(d.prompt).toBe("Do the thing.");
    expect(d.message).toBeUndefined();
  });

  it("puts the body on message for a gate", () => {
    const d = stepFromFile(`---\nid: g\ntype: gate\n---\nApprove?`, "g");
    expect(d.message).toBe("Approve?");
    expect(d.prompt).toBeUndefined();
  });

  it("every library file parses and declares a type", async () => {
    const dir = path.join(ROOT, "steps");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) {
      const d = stepFromFile(await fs.readFile(path.join(dir, f), "utf8"), f.slice(0, -3));
      expect(d.id, `${f} has no id`).toBeTruthy();
      expect(d.type, `${f} has no type`).toBeTruthy();
    }
  });
});

describe("resolving a reference", () => {
  const lib = {
    snapshot: { id: "snapshot", title: "Snapshot baseline", type: "snapshot" as const },
    analyse: { id: "analyse", title: "Design", type: "agent" as const, prompt: "p", role: "design" as const },
  };

  it("takes a bare id as-is", () => {
    expect(resolveStep("snapshot", lib)).toEqual(lib.snapshot);
  });

  it("applies an allowed override without touching the library copy", () => {
    const r = resolveStep({ use: "snapshot", title: "Snapshot current local state" }, lib);
    expect(r.title).toBe("Snapshot current local state");
    expect(lib.snapshot.title).toBe("Snapshot baseline");
  });

  it("renames with `as`, so run-time step ids are preserved", () => {
    expect(resolveStep({ use: "analyse", as: "design" }, lib).id).toBe("design");
  });

  it("refuses to override the step's substance", () => {
    expect(() => resolveStep({ use: "analyse", prompt: "different" }, lib)).toThrow(/its own file/);
    expect(() => resolveStep({ use: "analyse", role: "review" }, lib)).toThrow(/cannot be overridden/);
  });

  it("throws on an unknown step rather than running something wrong", () => {
    expect(() => resolveStep("does-not-exist", lib)).toThrow(/not in the step library/);
  });

  it("tells a reference apart from an inline step", () => {
    expect(isStepRef("snapshot")).toBe(true);
    expect(isStepRef({ use: "snapshot", title: "x" })).toBe(true);
    expect(isStepRef({ id: "snapshot", type: "snapshot" })).toBe(false);
  });
});
