import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractDelta } from "@/lib/workflows/artifacts";
import { render, writeUpdate } from "@/lib/workflows/designDoc";

/** Run d0e4f7bc-1d6: the design document sat inside the state block, ahead of
 * the step's own instructions. That put 88 KB between the agent and its task -
 * the instructions began at offset 93,720 of a 147 KB prompt - and the revision
 * skimmed: it declared 32 of 34 blocks unchanged, ignored all 22 the engine had
 * listed as open, and edited one marked "do not touch". The authoring pass,
 * which inlines no document, had worked properly on the same model minutes
 * earlier.
 *
 * The rule this pins: a step is told what to do BEFORE it is handed the data. */
describe("prompt order: task before data", () => {
  const MD = [
    "## OVERVIEW",
    "Not greenfield.",
    "",
    ...Array.from({ length: 30 }, (_, i) => {
      const id = `REQ-${String(i + 1).padStart(3, "0")}`;
      return [
        `### ${id}: Requirement ${i + 1}`,
        "STATUS: PARTIAL",
        `DESIGN: ${"a detailed design paragraph. ".repeat(40)}`,
        "EFFORT: 2d",
        "",
      ].join("\n");
    }),
  ].join("\n");

  it("keeps the document out of the state summary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dhruva-order-"));
    await writeUpdate(root, "docs/design.md", MD, 1, extractDelta(MD));
    const rendered = render(
      JSON.parse(fs.readFileSync(path.join(root, "docs/design.json"), "utf8")),
    );
    // the document is substantial - that is the point of keeping it last
    expect(rendered.length).toBeGreaterThan(30_000);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The engine assembles: … state summary · instructions · contracts · DOCUMENT.
   * Asserted on the source so a future edit cannot quietly put it back. */
  it("assembles the document after the step prompt and the contracts", () => {
    const engine = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/workflows/engine.ts"),
      "utf8",
    );
    const at = (needle: string) => {
      const i = engine.indexOf(needle);
      expect(i, `not found: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    const assembly = engine.slice(at("const prompt ="), at("OUTCOME_INSTRUCTION +") + 400);
    const pos = (n: string) => {
      const i = assembly.indexOf(n);
      expect(i, `not in the prompt assembly: ${n}`).toBeGreaterThan(-1);
      return i;
    };
    expect(pos("stateBlock")).toBeLessThan(pos("template(def.prompt"));
    expect(pos("template(def.prompt")).toBeLessThan(pos("OUTCOME_INSTRUCTION"));
    expect(pos("OUTCOME_INSTRUCTION")).toBeLessThan(pos("documentBlock"));
  });

  it("restates the task after the document", () => {
    const engine = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/workflows/engine.ts"),
      "utf8",
    );
    expect(engine).toContain("Now produce the DELTA exactly as instructed above");
  });
});
