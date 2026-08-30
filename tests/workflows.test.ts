import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkWorkflowSemantics, validateWorkflowDef } from "@/lib/workflows/validate";
import { isStepRef, loadStepLibrary, resolveStep, type StepRef } from "@/lib/workflows/steps";
import { CATEGORIES } from "@/components/workflows/StepTrace";
import { builtinWorkflows } from "@/lib/workflows/builtins";
import type { WorkflowDef } from "@/lib/workflows/schema";

process.env.DHRUVA_STEPS_DIR ??= path.resolve(__dirname, "../steps");

/** Shipped workflows name their steps from the library, so a raw file has to be
 * resolved before it can be validated - the resolved shape is what runs. */
async function resolved(raw: unknown): Promise<unknown> {
  const library = await loadStepLibrary();
  const d = raw as { steps?: unknown[] };
  if (Array.isArray(d?.steps)) {
    d.steps = d.steps.map((s) => (isStepRef(s) ? resolveStep(s as string | StepRef, library) : s));
  }
  return d;
}

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
        const def = validateWorkflowDef(await resolved(parsed));
        if (ids.has(def.id)) failures.push(`${f}: duplicate workflow id "${def.id}"`);
        ids.add(def.id);
        for (const p of checkWorkflowSemantics(def)) failures.push(`${f}: ${p}`);
      } catch (e) {
        failures.push(`${f}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    // reads and resolves every workflow and every step file it references -
    // dozens of serial disk reads, which drifts past the 5s default when the
    // suite runs test files in parallel
  }, 20_000);

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

/** Artefact paths a prompt writes, without regex escaping games: split on
 * whitespace and keep the tokens that start in the run folder. */
function artefactPaths(text: string): string[] {
  return text
    .split(/[\s"`(),]+/)
    .filter((w) => w.startsWith(".dhruva/runs/"))
    .map((w) => w.replace(/[.,;:]+$/, ""));
}

describe("design outputs cannot overwrite each other", () => {
  it("puts every written artefact under the run's own folder", async () => {
    // The run id used to be stamped into each FILENAME in one shared folder.
    // It is now the folder itself, so a second run cannot reach the first's
    // files at all - and the paths no longer depend on the doc name, which is
    // what silently broke a chain with a custom docName.
    for (const f of ["solution-design.json", "ux-design.json"]) {
      const raw = await fs.readFile(path.resolve(__dirname, "../workflows", f), "utf8");
      const def = (await resolved(JSON.parse(raw))) as { steps: { prompt?: string }[] };
      const text = def.steps.map((s) => s.prompt ?? "").join("\n");
      const written = artefactPaths(text);
      expect(written.length, `${f} writes no artefact`).toBeGreaterThan(0);
      for (const p of written) expect(p, `${f}: ${p}`).toContain("{runId}");
    }
  });

  it("no artefact path depends on the document name any more", async () => {
    for (const f of ["solution-design.json", "ux-design.json", "implement-tdd.json"]) {
      const raw = await fs.readFile(path.resolve(__dirname, "../workflows", f), "utf8");
      const def = (await resolved(JSON.parse(raw))) as { steps: { prompt?: string }[] };
      const text = def.steps.map((s) => s.prompt ?? "").join("\n");
      const paths = artefactPaths(text);
      for (const p of paths) expect(p, `${f}: ${p}`).not.toContain("docName");
    }
  });

  it("nothing writes to the old shared folder", async () => {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      expect(raw, f).not.toContain("dhruva-docs/designs/");
    }
  });

  it("implement-tdd no longer defaults to a fixed design filename", async () => {
    const raw = await fs.readFile(path.resolve(__dirname, "../workflows/implement-tdd.json"), "utf8");
    const def = JSON.parse(raw) as { inputs: { key: string; default?: string }[] };
    expect(def.inputs.find((i) => i.key === "tddPath")?.default).toBe("");
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

/** The catalog groups workflows by category, and an unlisted one falls through
 * to the FIRST group rather than erroring - so a new workflow whose id nobody
 * added here appears under "Development" with no warning at all. Cheap to
 * guard, invisible to debug. */
describe("every shipped workflow is categorised", () => {
  it("no workflow silently falls into the first group", async () => {
    const listed = new Set(CATEGORIES.flatMap(([, ids]) => ids));
    const shipped = Object.keys(await builtinWorkflows());
    const uncategorised = shipped.filter((id) => !listed.has(id));
    expect(uncategorised, `add these to CATEGORIES in StepTrace.tsx`).toEqual([]);
  });

  it("no category names a workflow that no longer exists", async () => {
    const shipped = new Set(Object.keys(await builtinWorkflows()));
    const stale = CATEGORIES.flatMap(([, ids]) => ids).filter((id) => !shipped.has(id));
    expect(stale, `these ids are in CATEGORIES but not shipped`).toEqual([]);
  });
});
