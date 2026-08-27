import { describe, expect, it } from "vitest";
import { buildIntakePrompt, parseIntakeReply, type IntakeCandidate } from "@/lib/intakeLlm";

const CATALOG: IntakeCandidate[] = [
  { id: "solution-design", title: "Solution design", description: "Architect path" },
  { id: "implement-tdd", title: "Implement from TDD", description: "Build from a TDD" },
  { id: "bug-fix", title: "Bug fix" },
  { id: "our-release", title: "Our release process", custom: true },
];

/** Agents narrate, wrap in fences and print banners; the answer has to be
 * found in that, and an id that is not ours must never reach the run button. */
describe("parseIntakeReply", () => {
  it("reads a chain answer", () => {
    const r = parseIntakeReply(
      '{"workflows":["solution-design","implement-tdd"],"reason":"asks for a design and its build"}',
      CATALOG,
    )!;
    expect(r.workflows).toEqual([
      { workflow: "solution-design", title: "Solution design" },
      { workflow: "implement-tdd", title: "Implement from TDD" },
    ]);
    expect(r.reason).toBe("asks for a design and its build");
  });

  it("digs the JSON out of a fenced, narrated reply", () => {
    const raw = [
      "[engine] model requested: gemini-3.6-flash",
      "Let me think about which workflow fits.",
      "```json",
      '{"workflows":["bug-fix"],"reason":"something is failing"}',
      "```",
      "[exit 0]",
    ].join("\n");
    expect(parseIntakeReply(raw, CATALOG)!.workflows).toEqual([
      { workflow: "bug-fix", title: "Bug fix" },
    ]);
  });

  it("keeps the custom workflow when the model picks it", () => {
    expect(parseIntakeReply('{"workflows":["our-release"],"reason":"x"}', CATALOG)!.workflows)
      .toEqual([{ workflow: "our-release", title: "Our release process" }]);
  });

  it("DROPS an id that is not in the catalog", () => {
    const r = parseIntakeReply(
      '{"workflows":["solution-design","deploy-to-prod-now"],"reason":"x"}',
      CATALOG,
    )!;
    expect(r.workflows).toEqual([{ workflow: "solution-design", title: "Solution design" }]);
  });

  it("returns null when EVERY id is invented - a bad answer, not a question", () => {
    // must fall back to the keyword classifier, not silently drop into chat
    expect(parseIntakeReply('{"workflows":["make-it-work"],"reason":"x"}', CATALOG)).toBeNull();
  });

  it("returns an EMPTY list for a question - a real answer, not a failure", () => {
    const r = parseIntakeReply('{"workflows":[],"reason":"just a question"}', CATALOG)!;
    expect(r).not.toBeNull();
    expect(r.workflows).toEqual([]);
  });

  it("returns null for unusable output", () => {
    expect(parseIntakeReply("", CATALOG)).toBeNull();
    expect(parseIntakeReply("command not found: copilot", CATALOG)).toBeNull();
    expect(parseIntakeReply('{"nope":1}', CATALOG)).toBeNull();
  });

  it("de-duplicates repeated phases", () => {
    const r = parseIntakeReply('{"workflows":["bug-fix","bug-fix"],"reason":"x"}', CATALOG)!;
    expect(r.workflows).toHaveLength(1);
  });

  it("caps the chain at 5 phases", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `w${i}`, title: `W${i}` }));
    const r = parseIntakeReply(
      JSON.stringify({ workflows: many.map((w) => w.id), reason: "x" }),
      many,
    )!;
    expect(r.workflows).toHaveLength(5);
  });
});

describe("buildIntakePrompt", () => {
  it("lists every workflow id the model may choose from", () => {
    const p = buildIntakePrompt("do the thing", [], CATALOG);
    for (const w of CATALOG) expect(p).toContain(w.id);
    expect(p).toContain("Never invent an id");
  });

  it("tells the model an attachment is evidence of real delivery work", () => {
    // the exact case the keyword classifier could not see: a BRD attached to a
    // 24-character instruction
    const p = buildIntakePrompt("Pls design and implement", ["BRD_Epic_3.docx"], CATALOG);
    expect(p).toContain("BRD_Epic_3.docx");
    expect(p).toMatch(/attached .*document is strong evidence/i);
  });

  it("says abbreviations count, which is what broke the keyword classifier", () => {
    expect(buildIntakePrompt("x", [], CATALOG)).toMatch(/pls/i);
  });
});
