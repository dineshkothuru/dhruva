import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { OUTCOME_INSTRUCTION, OUTCOME_END, OUTCOME_START, parseOutcome } from "@/lib/outcome";

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
    expect(engine).toMatch(/feedbackBlock \+\s*(\/\/[^\n]*\n\s*)*OUTCOME_INSTRUCTION/);
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
