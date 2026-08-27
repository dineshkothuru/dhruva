import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkWorkflowSemantics, validateWorkflowDef } from "@/lib/workflows/validate";
import type { WorkflowDef } from "@/lib/workflows/schema";

/** Every shipped workflow must satisfy the SAME contract user-authored
 * customs do. This is the guard that stops a hand-edited JSON file from
 * shipping broken - the failure would otherwise surface mid-run, after the
 * user has already spent tokens. */
const dir = path.resolve(__dirname, "../workflows");

describe("shipped workflow definitions", () => {
  it("has workflow files to check", async () => {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(5);
  });

  it("every file is valid JSON, passes the validator, and has no semantic problems", async () => {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const failures: string[] = [];
    const ids = new Set<string>();

    for (const f of files) {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        failures.push(`${f}: invalid JSON - ${String(e)}`);
        continue;
      }
      try {
        const def = validateWorkflowDef(parsed);
        if (ids.has(def.id)) failures.push(`${f}: duplicate workflow id "${def.id}"`);
        ids.add(def.id);
        for (const p of checkWorkflowSemantics(def)) failures.push(`${f}: ${p}`);
      } catch (e) {
        failures.push(`${f}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("contains no em or en dashes (house style)", async () => {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const offenders: string[] = [];
    for (const f of files) {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      if (/[–—]/.test(raw)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("validateWorkflowDef", () => {
  const good = {
    id: "demo-flow",
    title: "Demo",
    steps: [{ id: "s1", type: "agent", title: "Do", prompt: "do it" }],
    inputs: [],
  };

  it("accepts a minimal definition", () => {
    expect(validateWorkflowDef(good).id).toBe("demo-flow");
  });

  it("rejects a non-slug id", () => {
    expect(() => validateWorkflowDef({ ...good, id: "Demo Flow" })).toThrow(/slug/);
  });

  it("rejects an id that collides with a built-in", () => {
    expect(() => validateWorkflowDef(good, new Set(["demo-flow"]))).toThrow(/collides/);
  });

  it("rejects an unknown step type", () => {
    expect(() => validateWorkflowDef({ ...good, steps: [{ id: "s1", type: "teleport" }] })).toThrow(/step type/);
  });

  it("rejects an agent step with no prompt", () => {
    expect(() => validateWorkflowDef({ ...good, steps: [{ id: "s1", type: "agent" }] })).toThrow(/prompt/);
  });

  it("rejects duplicate step ids", () => {
    expect(() =>
      validateWorkflowDef({
        ...good,
        steps: [
          { id: "s1", type: "agent", prompt: "a" },
          { id: "s1", type: "agent", prompt: "b" },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects an empty step list", () => {
    expect(() => validateWorkflowDef({ ...good, steps: [] })).toThrow(/steps/);
  });
});

describe("checkWorkflowSemantics", () => {
  // built directly: validateWorkflowDef runs this check itself and throws,
  // so a semantically broken definition cannot be produced through it
  const def = (steps: unknown[], inputs: unknown[] = []) =>
    ({ id: "x-flow", title: "X", description: "", inputs, steps }) as unknown as WorkflowDef;

  it("flags a placeholder for an undeclared input", () => {
    const problems = checkWorkflowSemantics(
      def([{ id: "s1", type: "agent", prompt: "use {inputs.missing}" }]),
    );
    expect(problems.join(" ")).toContain("no such input");
  });

  it("flags a reference to a step that runs later", () => {
    const problems = checkWorkflowSemantics(
      def([
        { id: "s1", type: "agent", prompt: "read {steps.s2.output}" },
        { id: "s2", type: "agent", prompt: "later" },
      ]),
    );
    expect(problems.join(" ")).toContain("runs at or after");
  });

  it("flags onlyIf pointing at an undeclared input", () => {
    const problems = checkWorkflowSemantics(
      def([{ id: "s1", type: "agent", prompt: "x", onlyIf: "notAnInput" }]),
    );
    expect(problems.join(" ")).toContain("onlyIf");
  });

  it("rejects such a definition at validation time too", () => {
    expect(() =>
      validateWorkflowDef({
        id: "y-flow",
        title: "Y",
        inputs: [],
        steps: [{ id: "s1", type: "agent", prompt: "use {inputs.missing}" }],
      }),
    ).toThrow(/no such input/);
  });

  it("passes a correct forward reference", () => {
    const def = validateWorkflowDef({
      id: "z-flow",
      title: "Z",
      inputs: [{ key: "req", label: "Req", kind: "text" }],
      steps: [
        { id: "s1", type: "agent", prompt: "start {inputs.req}" },
        { id: "s2", type: "agent", prompt: "continue {steps.s1.output}" },
      ],
    });
    expect(checkWorkflowSemantics(def)).toEqual([]);
  });
});

describe("design outputs cannot overwrite each other", () => {
  it("stamps every design artefact with the run id", async () => {
    const raw = await fs.readFile(path.resolve(__dirname, "../workflows/solution-design.json"), "utf8");
    // every deliverable path the workflow writes must carry {runId}
    const written = raw.match(/dhruva-docs\/designs\/\{inputs\.docName\}[A-Za-z{}.-]*/g) ?? [];
    expect(written.length).toBeGreaterThan(0);
    for (const p of written) expect(p).toContain("{runId}");
  });

  it("leaves no fixed filename that a second run would clobber", async () => {
    for (const f of ["solution-design.json", "ux-design.json"]) {
      const raw = await fs.readFile(path.resolve(__dirname, "../workflows", f), "utf8");
      expect(raw).not.toMatch(/dhruva-docs\/designs\/\{inputs\.docName\}-(hld|tdd|tasks|ux)/);
    }
  });

  it("implement-tdd no longer defaults to a fixed design filename", async () => {
    const raw = await fs.readFile(path.resolve(__dirname, "../workflows/implement-tdd.json"), "utf8");
    const def = JSON.parse(raw) as { inputs: { key: string; default?: string }[] };
    const tdd = def.inputs.find((i) => i.key === "tddPath");
    expect(tdd?.default).toBe("");
  });
});

describe("deliverables live in their own folder", () => {
  it("writes under dhruva-docs, never a team's own docs/ tree", async () => {
    for (const f of ["solution-design.json", "ux-design.json", "implement-tdd.json"]) {
      const raw = await fs.readFile(path.resolve(__dirname, "../workflows", f), "utf8");
      // no bare docs/designs path may remain
      expect(raw).not.toMatch(/(?<!dhruva-)docs\/designs/);
    }
  });
});
