import { describe, expect, it } from "vitest";
import { brdUnits, citedUnits, coverageOf, attachmentPaths } from "@/lib/workflows/traceability";

/** Coverage is counted, not judged. Three runs of the SAME byte-identical BRD
 * produced 11, 16 and 15 requirements, and nothing could tell you whether
 * anything had been dropped - the reviewer was asked for an opinion with no
 * list to count against. */
describe("units the source document declares", () => {
  const BRD = [
    "Table of Contents",
    "User Stories\t4",
    "US-1: View and manage Activity Finder Info\t4",
    "US-2: Publish an event\t7",
    "",
    "US-1: View and manage Activity Finder Info",
    "Acceptance Criteria",
    "AC1",
    "AC2",
    "The behaviour here is related to US-2 elsewhere in this document.",
    "AC3",
    "",
    "US-2: Publish an event",
    "AC1",
    "AC2",
  ].join("\n");

  it("ignores table-of-contents rows when opening a story", () => {
    // a TOC row ends in a tab and a page number; treating it as a heading moved
    // the pointer before any real content and misfiled the ACs that followed
    const u = brdUnits(BRD);
    expect(u.filter((x) => x.startsWith("US-1 AC"))).toEqual(["US-1 AC1", "US-1 AC2", "US-1 AC3"]);
  });

  it("does not let a cross-reference steal the following ACs", () => {
    // "related to US-2" sits inside the US-1 section; AC3 belongs to US-1.
    // Measured on a real BRD this exact shape filed US-1 AC5 under US-2, and
    // US-1 AC5 then read as an uncovered requirement.
    expect(brdUnits(BRD)).toContain("US-1 AC3");
    expect(brdUnits(BRD)).not.toContain("US-2 AC3");
  });

  it("lists each story once, in document order", () => {
    expect(brdUnits(BRD).filter((x) => !x.includes(" "))).toEqual(["US-1", "US-2"]);
  });
});

describe("units the design claims", () => {
  it("expands an AC range", () => {
    const c = citedUnits("BRD-REF: US-1, AC2-AC5");
    expect([...c].sort()).toEqual(["US-1", "US-1 AC2", "US-1 AC3", "US-1 AC4", "US-1 AC5"]);
  });

  it("expands an en-dash range the same way", () => {
    expect(citedUnits("BRD-REF: US-2, AC1\u2013AC3").has("US-2 AC2")).toBe(true);
  });

  it("reads a comma list", () => {
    const c = citedUnits("BRD-REF: US-3, AC1, AC3, AC5");
    expect(c.has("US-3 AC3")).toBe(true);
    expect(c.has("US-3 AC2")).toBe(false);
  });

  it("a story reference with no AC claims the story only", () => {
    const c = citedUnits("BRD-REF: US-1 Business Rules");
    expect([...c]).toEqual(["US-1"]);
  });

  it("ignores lines that are not BRD-REF", () => {
    expect(citedUnits("DESIGN: relates to US-1, AC2").size).toBe(0);
  });
});

describe("what the design leaves unclaimed", () => {
  it("names the units no BRD-REF covers", () => {
    const doc = ["US-1: A", "AC1", "AC2", "US-2: B", "AC1"].join("\n");
    const design = "BRD-REF: US-1, AC1\n### REQ-002\nBRD-REF: US-2, AC1";
    const cov = coverageOf(doc, design);
    expect(cov.units).toContain("US-1 AC2");
    expect(cov.uncited).toEqual(["US-1 AC2"]);
  });

  it("reports nothing uncited when every unit is claimed", () => {
    const doc = ["US-1: A", "AC1"].join("\n");
    expect(coverageOf(doc, "BRD-REF: US-1, AC1").uncited).toEqual([]);
  });
});

describe("finding the source document", () => {
  it("accepts a staged path, a run-owned path, and the pre-move layout", () => {
    expect(attachmentPaths("x .dhruva/tmp/attachments/ab12-BRD.docx.extracted.md")).toHaveLength(1);
    expect(
      attachmentPaths("x .dhruva/runs/0cf6c381-17f/attachments/ab12-BRD.docx.extracted.md"),
    ).toHaveLength(1);
    expect(attachmentPaths("x .dhruva/attachments/ab12-BRD.docx.extracted.md")).toHaveLength(1);
  });

  it("takes only the deterministic extract, never the binary", () => {
    expect(attachmentPaths("x .dhruva/tmp/attachments/ab12-BRD.docx")).toEqual([]);
  });

  it("refuses a path outside the harness folders", () => {
    expect(attachmentPaths("x ../../etc/passwd.extracted.md")).toEqual([]);
    expect(attachmentPaths("x C:/secrets/thing.extracted.md")).toEqual([]);
  });
});
