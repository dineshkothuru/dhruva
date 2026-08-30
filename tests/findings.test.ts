import { describe, expect, it } from "vitest";
import { parseFindings } from "@/lib/findings";

/** The reviewer-findings parser feeds the gate panel and the step trace.
 * Its failure mode is silent: a bad regex drops or merges findings and the
 * human approves work believing fewer issues were raised. */
describe("parseFindings", () => {
  const sample = [
    "I read the BRD in full and verified every cited component.",
    "F1 (critical) [refs: REQ-007, REQ-013]: Portal sharing plan is not implementable",
    "  Where: Event_Profile__c.object-meta.xml",
    "  Problem: sharing is disabled so no share table exists",
    "  Fix: set enableSharing to true, then merge this with F3 to avoid duplication",
    "F2 (nit) [refs: REQ-002]: Field label casing",
    "  Problem: inconsistent casing",
    "  Fix: use the query",
    "[SELECT Id FROM Account]",
    "VERDICT: BLOCKED - F1 must be resolved",
  ].join("\n");

  it("splits every finding and keeps the narration before them", () => {
    const r = parseFindings(sample);
    expect(r.findings).toHaveLength(2);
    expect(r.before).toContain("I read the BRD in full");
  });

  it("parses id, severity, refs and title", () => {
    const [f1] = parseFindings(sample).findings;
    expect(f1.id).toBe("F1");
    expect(f1.severity).toBe("critical");
    expect(f1.refs).toEqual(["REQ-007", "REQ-013"]);
    expect(f1.title).toBe("Portal sharing plan is not implementable");
    expect(f1.where).toContain("Event_Profile__c");
  });

  it("does NOT split on an F-marker mentioned mid-sentence", () => {
    const [f1] = parseFindings(sample).findings;
    expect(f1.fix).toContain("merge this with F3");
  });

  it("keeps a continuation line that starts with a bracket (SOQL)", () => {
    const [, f2] = parseFindings(sample).findings;
    expect(f2.fix).toContain("SELECT Id FROM Account");
  });

  it("puts the verdict in trailing, not inside a finding", () => {
    const r = parseFindings(sample);
    expect(r.trailing).toContain("VERDICT: BLOCKED");
    expect(r.findings[1].fix).not.toContain("VERDICT");
  });

  it("ignores an F-token inside prose when deciding where findings begin", () => {
    const r = parseFindings(
      "We store UTF8 text and F8 was discussed earlier.\nF1 (important) [refs: -]: real finding\n  Problem: x\n  Fix: y\n[exit 0]",
    );
    expect(r.findings).toHaveLength(1);
    expect(r.before).toContain("F8 was discussed");
    expect(r.findings[0].fix).toBe("y");
  });

  it("supports the legacy 'F1: title (critical)' format", () => {
    const r = parseFindings("F1: Old style problem (critical)\n  Problem: p\n  Fix: f");
    expect(r.findings[0].severity).toBe("critical");
    expect(r.findings[0].title).toBe("Old style problem");
  });

  it("returns no findings for output that has none", () => {
    const r = parseFindings("Everything looks good.\nVERDICT: APPROVED");
    expect(r.findings).toHaveLength(0);
    expect(r.before).toContain("Everything looks good");
  });
});

/** Run c10adbb1-2fb: the engine renders findings into the design document as
 * "#### F12 (critical): ..." headings, and by round 8 the reviewer - which
 * reads that document every round - had copied the format into its own answer.
 * Nothing parsed, the step failed its own `emits: findings` contract, and a
 * 2h51m run died one step before the human gate. */
describe("a finding written as a markdown heading", () => {
  const HEADING = [
    "#### F73 (nit) [refs: REQ-034]: orphan STATE flipped from clean to open",
    "- Where: design.md REQ-034",
    "- Problem: nothing documents why",
    "- Fix: attach STATE to the block",
    "",
    "VERDICT: BLOCKED - F73",
  ].join("\n");

  it("parses the same as one written at line start", () => {
    const { findings } = parseFindings(HEADING);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("F73");
    expect(findings[0].severity).toBe("nit");
    expect(findings[0].refs).toEqual(["REQ-034"]);
    expect(findings[0].fix).toContain("attach STATE");
  });

  it("still parses a plain finding unchanged", () => {
    const { findings } = parseFindings("F1 (critical): plain\n  Where: x\n  Fix: y");
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("F1");
  });
});
