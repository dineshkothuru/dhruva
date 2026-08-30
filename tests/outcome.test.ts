import { describe, expect, it } from "vitest";
import { OUTCOME_END, OUTCOME_START, parseOutcome, stripOutcome } from "@/lib/outcome";

const block = (body: string) => `${OUTCOME_START}\n${body}\n${OUTCOME_END}`;

/** The trace previously guessed what a step produced by counting patterns in
 * free prose. This block is the agent stating it directly, so the parser has
 * to be exact - and has to degrade cleanly when the block is missing. */
describe("parseOutcome", () => {
  it("returns null when the block is absent (older runs keep working)", () => {
    expect(parseOutcome("I read the BRD and wrote the design.")).toBeNull();
  });

  it("parses summary, produced items and confidence", () => {
    const o = parseOutcome(
      "prose above\n" +
        block(
          "SUMMARY: Designed 17 requirements against the existing org.\n" +
            "PRODUCED: 17 requirement designs | an ERD | a migration order\n" +
            "CONFIDENCE: high",
        ),
    )!;
    expect(o.summary).toBe("Designed 17 requirements against the existing org.");
    expect(o.produced).toEqual(["17 requirement designs", "an ERD", "a migration order"]);
    expect(o.confidence).toBe("high");
  });

  it("captures the reason when confidence is not high", () => {
    const o = parseOutcome(block("SUMMARY: s\nCONFIDENCE: low - the BRD contradicts itself"))!;
    expect(o.confidence).toBe("low");
    expect(o.confidenceNote).toContain("contradicts");
  });

  it("treats 'nothing' as no artefacts, for read-only steps", () => {
    const o = parseOutcome(block("SUMMARY: Read the codebase.\nPRODUCED: nothing"))!;
    expect(o.produced).toEqual([]);
    expect(o.summary).toBe("Read the codebase.");
  });

  it("takes the LAST block when a model echoes the template first", () => {
    const o = parseOutcome(
      block("SUMMARY: template example\nPRODUCED: x") +
        "\nactual work\n" +
        block("SUMMARY: the real one\nPRODUCED: y"),
    )!;
    expect(o.summary).toBe("the real one");
    expect(o.produced).toEqual(["y"]);
  });

  it("survives a truncated block with no end marker", () => {
    const o = parseOutcome(`${OUTCOME_START}\nSUMMARY: cut off mid-write`)!;
    expect(o.summary).toBe("cut off mid-write");
  });

  it("returns null for an empty block rather than a blank outcome", () => {
    expect(parseOutcome(block(""))).toBeNull();
  });

  it("caps a runaway produced list", () => {
    const many = Array.from({ length: 30 }, (_, i) => `item${i}`).join(" | ");
    expect(parseOutcome(block(`SUMMARY: s\nPRODUCED: ${many}`))!.produced.length).toBe(8);
  });

  /** A hard slice cut a real summary at "...a thin CRUD scaffold requiring a",
   * which reads as a broken renderer rather than a sentence that ran long. */
  it("cuts an over-long summary at a word boundary and marks it", () => {
    const long = "word ".repeat(400).trim();
    const out = parseOutcome(block(`SUMMARY: ${long}`))!;
    expect(out.summary.length).toBeLessThanOrEqual(701);
    expect(out.summary.endsWith("…")).toBe(true);
    expect(out.summary).not.toMatch(/\bwor…$/); // never mid-word
  });

  it("leaves a summary that fits completely alone", () => {
    const out = parseOutcome(block("SUMMARY: short and complete."))!;
    expect(out.summary).toBe("short and complete.");
    expect(out.summary).not.toContain("…");
  });
});

describe("stripOutcome", () => {
  it("removes the block so the machine plumbing is never shown", () => {
    const text = "the real narration\n" + block("SUMMARY: s\nPRODUCED: p");
    const out = stripOutcome(text);
    expect(out).toBe("the real narration");
    expect(out).not.toContain(OUTCOME_START);
  });

  it("keeps anything the agent wrote after the block", () => {
    const out = stripOutcome("before\n" + block("SUMMARY: s") + "\n[exit 0]");
    expect(out).toContain("before");
    expect(out).toContain("[exit 0]");
  });

  it("leaves output without a block untouched", () => {
    expect(stripOutcome("plain output")).toBe("plain output");
  });
});
