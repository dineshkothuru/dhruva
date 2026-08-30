import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { OUTCOME_INSTRUCTION, OUTCOME_END, OUTCOME_START, parseOutcome } from "@/lib/outcome";
import { COVERAGE_INSTRUCTION, FINDINGS_INSTRUCTION, parseFindings } from "@/lib/findings";

/** The outcome contract has two halves that must stay in step: the text sent
 * to the agent, and the parser that reads what comes back. They used to be
 * separate copies - the instruction was pasted into 25 workflow prompts while
 * the constant went unused, so editing one would silently not change the
 * other. The engine now appends the constant itself; these tests hold that. */
describe("the outcome contract has ONE source", () => {
  it("the engine appends the instruction to every agent prompt", async () => {
    const engine = await fs.readFile(
      path.resolve(__dirname, "../src/lib/workflows/engine.ts"),
      "utf8",
    );
    expect(engine).toContain("OUTCOME_INSTRUCTION");
    // appended after the step's own prompt and any reviewer feedback; the
    // declared contract instructions sit between the two, so this asserts
    // composition rather than adjacency.
    //
    // The document a step works ON comes LAST, after the contracts: putting it
    // ahead of them once left the instructions at offset 93,720 of a 147 KB
    // prompt, and the revision that read it ignored 22 open requirements.
    expect(engine).toMatch(/feedbackBlock \+[\s\S]{0,700}OUTCOME_INSTRUCTION \+/);
    expect(engine).toMatch(/OUTCOME_INSTRUCTION \+[\s\S]{0,400}documentBlock;/);
  });

  it("no shipped workflow carries its own copy of the block", async () => {
    const dir = path.resolve(__dirname, "../workflows");
    const offenders: string[] = [];
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      if (raw.includes(OUTCOME_START)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("the instruction it sends is parseable by the parser that reads it", () => {
    // the shape the instruction asks for must round-trip through parseOutcome
    expect(OUTCOME_INSTRUCTION).toContain(OUTCOME_START);
    expect(OUTCOME_INSTRUCTION).toContain(OUTCOME_END);
    const asAgentWouldReply = [
      OUTCOME_START,
      "SUMMARY: Did the thing.",
      "PRODUCED: a file | a test",
      "CONFIDENCE: medium - the spec was ambiguous",
      OUTCOME_END,
    ].join("\n");
    const parsed = parseOutcome(asAgentWouldReply)!;
    expect(parsed.summary).toBe("Did the thing.");
    expect(parsed.produced).toEqual(["a file", "a test"]);
    expect(parsed.confidence).toBe("medium");
  });

  it("names every field the parser looks for", () => {
    for (const field of ["SUMMARY", "PRODUCED", "CONFIDENCE"]) {
      expect(OUTCOME_INSTRUCTION).toContain(`${field}:`);
    }
  });
});

/** The findings and coverage contracts had the same problem the outcome block
 * once had: the text was written out longhand in every step that used it - five
 * copies of the findings shape alone - free to drift from the parser one edit
 * at a time. They are now constants beside their parsers, appended by the
 * engine when a step declares `emits`. */
describe("the machine-read contracts have ONE source each", () => {
  it("the engine appends the declared contract, not the step file", async () => {
    const engine = await fs.readFile(
      path.resolve(__dirname, "../src/lib/workflows/engine.ts"),
      "utf8",
    );
    expect(engine).toContain('def.emits === "findings" ? FINDINGS_INSTRUCTION');
    expect(engine).toContain('def.emits === "coverage" ? COVERAGE_INSTRUCTION');
  });

  it("no step file carries its own copy of a contract", async () => {
    const dir = path.resolve(__dirname, "../steps");
    const offenders: string[] = [];
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".md")) continue;
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      if (raw.includes("F<n> (critical")) offenders.push(`${f}: findings shape`);
      if (raw.includes("COVERAGE: COMPLETE")) offenders.push(`${f}: coverage shape`);
      if (raw.includes(OUTCOME_START)) offenders.push(`${f}: outcome block`);
    }
    expect(offenders).toEqual([]);
  });

  it("the findings instruction is parseable by the parser that reads it", () => {
    const asAgentWouldReply = [
      "F1 (critical) [refs: REQ-007]: Write path contradicts its own FLS model",
      "  Where: REQ-009 DESIGN",
      "  Problem: the publish path writes fields the running user cannot see",
      "  Fix: widen the permission set, or drop USER_MODE on that write",
      "",
      "VERDICT: BLOCKED - F1",
    ].join("\n");
    const { findings } = parseFindings(asAgentWouldReply);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("F1");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].refs).toEqual(["REQ-007"]);
    expect(findings[0].fix).toContain("widen the permission set");
  });

  it("names every label the findings parser looks for", () => {
    for (const label of ["Where:", "Problem:", "Fix:", "VERDICT:"]) {
      expect(FINDINGS_INSTRUCTION).toContain(label);
    }
    expect(FINDINGS_INSTRUCTION).toContain("F<n> (critical | important | nit)");
  });

  it("the coverage instruction matches the trigger the engine greps for", () => {
    expect(COVERAGE_INSTRUCTION).toMatch(/COVERAGE: COMPLETE/);
    expect(/COVERAGE:\s*(COMPLETE|INCOMPLETE)/i.test("COVERAGE: INCOMPLETE - items REQ-4")).toBe(true);
  });
});
