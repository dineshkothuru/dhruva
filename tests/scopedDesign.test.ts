import { describe, expect, it } from "vitest";
import { dependencyClosure, renderScoped, fromMarkdown } from "@/lib/workflows/designDoc";
import { sliceRequirements } from "@/lib/workflows/templating";

/** Revision prompts carry the design's dependency CLOSURE in full and settled
 * unrelated blocks as contract stubs - the token diet must never hide a block
 * a change could ripple into, and a stub must keep every committed component
 * (DESIGN, DEPENDS-ON) while dropping only audit prose (EVIDENCE, REJECTED). */

const md = [
  "# OVERVIEW",
  "Three requirements.",
  "",
  "### REQ-001: Alpha",
  "BRD-REF: US-1 AC1",
  "STATUS: NEW",
  "EVIDENCE: `Alpha.cls` file opened at line 3",
  "DESIGN: create `AlphaService.cls`",
  "REJECTED: flow - needs callout",
  "EFFORT: 1d",
  "DEPENDS-ON: -",
  "",
  "### REQ-002: Beta",
  "BRD-REF: US-2 AC1",
  "STATUS: NEW",
  "EVIDENCE: `Beta.cls` read fully",
  "DESIGN: extend `AlphaService.cls` with beta()",
  "REJECTED: -",
  "EFFORT: 1d",
  "DEPENDS-ON: REQ-001",
  "",
  "### REQ-003: Gamma",
  "BRD-REF: US-3 AC1",
  "STATUS: NEW",
  "EVIDENCE: `Gamma.cls` read fully",
  "DESIGN: create `GammaJob.cls`",
  "REJECTED: -",
  "EFFORT: 2d",
  "DEPENDS-ON: -",
  "",
].join("\n");

function docWithOpen(openId: string) {
  const doc = fromMarkdown(md)!;
  // freshly authored blocks are all "open"; a revision round is when most are
  // settled and one finding holds a block - that is the scenario under test
  for (const b of doc.blocks) b.state = "clean";
  const held = doc.blocks.find((b) => b.id === openId)!;
  held.state = "open";
  doc.findings.push({
    id: "F1",
    severity: "critical",
    refs: [openId],
    title: "t",
    where: "w",
    problem: "p",
    fix: "f",
    status: "open",
    needs: "fix",
  } as never);
  return doc;
}

describe("dependency-closure revision payloads", () => {
  it("closure = in-play blocks plus one DEPENDS-ON hop, both directions", () => {
    // REQ-001 open: REQ-002 depends on it -> both in closure; REQ-003 out
    const closure = dependencyClosure(docWithOpen("REQ-001"));
    expect([...closure].sort()).toEqual(["REQ-001", "REQ-002"]);
    // REQ-002 open: it depends on REQ-001 -> both in; REQ-003 out
    const closure2 = dependencyClosure(docWithOpen("REQ-002"));
    expect([...closure2].sort()).toEqual(["REQ-001", "REQ-002"]);
  });

  it("stubs keep the contract fields and drop the audit prose", () => {
    const doc = docWithOpen("REQ-001");
    const out = renderScoped(doc, dependencyClosure(doc));
    // in-play block: full
    expect(out).toContain("EVIDENCE: `Alpha.cls`");
    // stubbed block keeps DESIGN + DEPENDS-ON (the ripple surface)...
    expect(out).toContain("### REQ-003: Gamma");
    expect(out).toContain("create `GammaJob.cls`");
    // ...but drops its audit prose and says why
    expect(out).not.toContain("EVIDENCE: `Gamma.cls`");
    expect(out).toContain("settled and unrelated to this round");
  });

  it("sliceRequirements keeps closure sections whole and stubs the rest", () => {
    const req = [
      "Preamble with NFRs.",
      "",
      "### REQ-001: Alpha",
      "AC1: does alpha things",
      "",
      "### REQ-002: Beta",
      "AC1: does beta things",
      "",
      "### REQ-003: Gamma",
      "AC1: does gamma things",
      "",
    ].join("\n");
    const out = sliceRequirements(req, new Set(["REQ-001", "REQ-002"]));
    expect(out).toContain("Preamble with NFRs.");
    expect(out).toContain("does alpha things");
    expect(out).toContain("does beta things");
    expect(out).not.toContain("does gamma things");
    expect(out).toContain("### REQ-003: Gamma");
    // non-REQ documents pass through untouched
    expect(sliceRequirements("just prose", new Set())).toBe("just prose");
  });
});
