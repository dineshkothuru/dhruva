import { describe, expect, it } from "vitest";
import {
  applyDelta,
  blockIds,
  blockStates,
  deferringFields,
  designFromOutput,
  droppedBlocks,
  duplicateBlocks,
  extractDelta,
  LINEAGE_MARK,
  parseBlocks,
  placeFindings,
  renderBlocks,
  setBlockStates,
  type ReviewRecord,
} from "@/lib/workflows/artifacts";
import type { Finding } from "@/lib/findings";

const f = (id: string, refs: string[], severity: Finding["severity"] = "critical"): Finding => ({
  id,
  severity,
  refs,
  title: `${id} title`,
  where: "SomeClass.cls:10",
  problem: "it is wrong",
  fix: "make it right",
});

const rec = (round: number, findings: Finding[]): ReviewRecord => ({
  round,
  verdict: "needs_work",
  findings,
  closed: [],
});

const DESIGN = [
  "# Solution design",
  "",
  "## OVERVIEW",
  "Not greenfield.",
  "",
  "### REQ-001: Search contracts",
  "STATUS: PARTIAL",
  "DESIGN: add a status predicate",
  "EFFORT: 1d",
  "",
  "### REQ-002: View contract details",
  "STATUS: PARTIAL",
  "DESIGN: reuse the existing tabset",
  "EFFORT: 2d",
  "",
  "### REQ-003: Allocate funds",
  "STATUS: NEW",
  "DESIGN: build the engine",
  "EFFORT: 4d",
].join("\n");

describe("parseBlocks / renderBlocks", () => {
  it("splits preamble from requirement blocks", () => {
    const p = parseBlocks(DESIGN);
    expect(p.preamble).toContain("## OVERVIEW");
    expect(p.blocks.map((b) => b.id)).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
    expect(p.blocks[1].design).toContain("reuse the existing tabset");
  });

  it("re-emits an untouched document unchanged", () => {
    expect(renderBlocks(parseBlocks(DESIGN)).trim()).toBe(DESIGN.trim());
  });

  it("separates the agent half from the engine half at the lineage mark", () => {
    const withHistory = `${DESIGN}\n\n${LINEAGE_MARK}\n\n##### R1 reviewer\n\nsome finding`;
    const last = parseBlocks(withHistory).blocks[2];
    expect(last.design).toContain("build the engine");
    expect(last.design).not.toContain("R1 reviewer");
    expect(last.lineage).toContain("R1 reviewer");
  });
});

describe("extractDelta", () => {
  it("treats an unfenced document as a full authoring pass", () => {
    const d = extractDelta(DESIGN);
    expect(d.mode).toBe("full");
    expect(d.body).toContain("REQ-001");
  });

  it("reports an empty output as none, so the caller can refuse it", () => {
    expect(extractDelta("   \n  ").mode).toBe("none");
  });

  it("reads only what is inside the fence", () => {
    const out = [
      "Good, the BRD exists. Now I will read it in full.",
      "=== DELTA START ===",
      "UNCHANGED: REQ-002, REQ-003",
      "",
      "### REQ-001: Search contracts",
      "DESIGN: add the predicate to both branches",
      "=== DELTA END ===",
      "",
      "AI Credits 178 (12m 44s)",
    ].join("\n");
    const d = extractDelta(out);
    expect(d.mode).toBe("delta");
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0].design).toContain("both branches");
    expect(d.unchanged).toEqual(["REQ-002", "REQ-003"]);
  });

  it("survives a mid-generation retry that opens the fence twice", () => {
    // run 1e3dc542-bbc round 2: the CLI restarted mid-answer and both copies
    // were parsed, leaving two different F23s in one document
    const out = [
      "=== DELTA START ===",
      "### REQ-001: Search contracts",
      "DESIGN: first attempt, truncated",
      "=== DELTA START ===",
      "### REQ-001: Search contracts",
      "DESIGN: second attempt, complete",
      "=== DELTA END ===",
    ].join("\n");
    const d = extractDelta(out);
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0].design).toContain("second attempt");
  });

  it("splits design fields from RESPONSE lines", () => {
    const out = [
      "=== DELTA START ===",
      "### REQ-001: Search contracts",
      "DESIGN: add the predicate",
      "EFFORT: 2d",
      "RESPONSE F24 CHECKED: read ContractSearchController.cls:485",
      "RESPONSE F24 ACCEPTED - FIXED: added the predicate",
      "=== DELTA END ===",
    ].join("\n");
    const b = extractDelta(out).blocks[0];
    expect(b.design).toBe("DESIGN: add the predicate\nEFFORT: 2d");
    expect(b.responses).toContain("F24 ACCEPTED - FIXED");
    expect(b.design).not.toContain("RESPONSE");
  });
});

describe("applyDelta", () => {
  it("replaces only the named block and leaves the rest byte-for-byte", () => {
    const d = extractDelta(
      [
        "=== DELTA START ===",
        "### REQ-002: View contract details",
        "DESIGN: rewritten",
        "=== DELTA END ===",
      ].join("\n"),
    );
    const r = applyDelta(DESIGN, d, 2);
    expect(r.applied).toEqual(["REQ-002"]);
    expect(r.text).toContain("DESIGN: rewritten");
    expect(r.text).toContain("DESIGN: add a status predicate");
    expect(r.text).toContain("DESIGN: build the engine");
    expect(blockIds(r.text)).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
  });

  it("records responses under the round that produced them", () => {
    const d = extractDelta(
      [
        "=== DELTA START ===",
        "### REQ-003: Allocate funds",
        "DESIGN: split compute and persist",
        "RESPONSE F24 ACCEPTED - FIXED: split the engine",
        "=== DELTA END ===",
      ].join("\n"),
    );
    const r = applyDelta(DESIGN, d, 2);
    expect(r.text).toContain("##### D2 designer");
    expect(r.text).toContain("F24 ACCEPTED - FIXED");
  });

  it("keeps the design when a block carries responses only", () => {
    // the shape used for a block the human approved and the reviewer objected to
    const d = extractDelta(
      [
        "=== DELTA START ===",
        "### REQ-001: Search contracts",
        "RESPONSE F41 REJECTED: the premise does not hold, see cls:485",
        "=== DELTA END ===",
      ].join("\n"),
    );
    const r = applyDelta(DESIGN, d, 3);
    expect(r.text).toContain("DESIGN: add a status predicate");
    expect(r.text).toContain("F41 REJECTED");
    expect(r.text).toContain("##### D3 designer");
  });

  it("reports an unknown id instead of inventing a block", () => {
    const d = extractDelta(
      ["=== DELTA START ===", "### REQ-099: invented", "DESIGN: nope", "=== DELTA END ==="].join("\n"),
    );
    const r = applyDelta(DESIGN, d, 2);
    expect(r.unknown).toEqual(["REQ-099"]);
    expect(r.applied).toEqual([]);
    expect(r.text).not.toContain("REQ-099");
  });
});

/** Run 1d3d7c24-cad: the designer sent DESIGN and EFFORT for a revised block,
 * exactly as asked, and BRD-REF / STATUS / EVIDENCE were deleted with them.
 * All 34 blocks carried the three after authoring; three rounds later five,
 * five and nine did. */
describe("a delta cannot delete a field by not mentioning it", () => {
  const FULL = [
    "### REQ-001: Search contracts",
    "BRD-REF: Feature 1, US-1, AC1-AC3",
    "STATUS: PARTIAL",
    "EVIDENCE: `ContractSearchController.cls:485`",
    "DESIGN: original approach",
    "EFFORT: 1d",
  ].join("\n");

  const only = (body: string) =>
    extractDelta(["=== DELTA START ===", "### REQ-001: Search contracts", body, "=== DELTA END ==="].join("\n"));

  it("keeps every field the delta leaves out", () => {
    const r = applyDelta(FULL, only("DESIGN: revised approach\nEFFORT: 2d"), 2);
    expect(r.text).toContain("BRD-REF: Feature 1, US-1, AC1-AC3");
    expect(r.text).toContain("STATUS: PARTIAL");
    expect(r.text).toContain("EVIDENCE: `ContractSearchController.cls:485`");
    expect(r.text).toContain("DESIGN: revised approach");
    expect(r.text).toContain("EFFORT: 2d");
    expect(r.text).not.toContain("original approach");
  });

  it("replaces a multi-line field body whole", () => {
    const r = applyDelta(
      FULL,
      only("DESIGN: line one\n  continued here\n  and here"),
      2,
    );
    expect(r.text).toContain("continued here");
    expect(r.text).not.toContain("original approach");
    expect(r.text).toContain("STATUS: PARTIAL");
  });

  it("appends a field the block did not have", () => {
    const r = applyDelta(FULL, only("DEPENDS-ON: REQ-002"), 2);
    expect(r.text).toContain("DEPENDS-ON: REQ-002");
    expect(r.text).toContain("BRD-REF: Feature 1, US-1, AC1-AC3");
  });

  it("leaves the engine's STATE line alone", () => {
    const stamped = setBlockStates(FULL, { "REQ-001": "open" });
    const r = applyDelta(stamped, only("DESIGN: revised"), 2);
    expect(blockStates(r.text)["REQ-001"]).toBe("open");
  });

  it("survives three rounds without shedding a field", () => {
    let doc = FULL;
    for (const n of [2, 3, 4]) {
      doc = applyDelta(doc, only(`DESIGN: pass ${n}`), n).text;
    }
    expect(doc).toContain("BRD-REF:");
    expect(doc).toContain("STATUS:");
    expect(doc).toContain("EVIDENCE:");
    expect(doc).toContain("DESIGN: pass 4");
  });
});

/** Run c10adbb1-2fb: the authoring pass drafted blocks out of order while it
 * investigated, then wrote the real design underneath, and the whole
 * transcript became the file - 86 requirement headings for 34 requirements.
 * The very next round, fenced, emitted 14 headings and only the 7 inside the
 * fence were kept, every one unique. */
describe("the authoring fence", () => {
  const OUT = [
    "Let me look at the codebase first.",
    "### REQ-001: draft title",
    "DESIGN: an early draft I later replaced",
    "Writing the full design now.",
    "=== DESIGN START ===",
    "## OVERVIEW",
    "The real design.",
    "",
    "### REQ-001: Search contracts",
    "DESIGN: the final answer",
    "=== DESIGN END ===",
    "MANUAL: Assign the permission sets - Setup > Permission Sets - after deploy",
  ].join("\n");

  it("keeps only what is inside the fence", () => {
    const d = extractDelta(designFromOutput(OUT));
    expect(d.mode).toBe("full");
    expect(d.body).toContain("the final answer");
    expect(d.body).not.toContain("an early draft");
    expect(d.body).not.toContain("Let me look at the codebase");
    expect((d.body.match(/^### REQ-/gm) ?? []).length).toBe(1);
  });

  it("falls back to the whole output when the agent omits the fence", () => {
    const d = extractDelta("## OVERVIEW\nx\n\n### REQ-001: t\nDESIGN: y");
    expect(d.mode).toBe("full");
    expect(d.body).toContain("REQ-001");
  });
});

/** 53 MANUAL lines landed inside the last requirement block, pushing that
 * block's engine-written STATE line to the bottom of the file. */
describe("MANUAL lines are the engine's, not the design's", () => {
  it("are stripped from the design body", () => {
    const out = [
      "### REQ-001: t",
      "DESIGN: y",
      "MANUAL: Assign the permission sets - Setup > Permission Sets - after deploy",
      "MANUAL: Publish the community - Setup > Digital Experiences - before deploy",
    ].join("\n");
    const body = designFromOutput(out);
    expect(body).toContain("DESIGN: y");
    expect(body).not.toContain("MANUAL:");
  });

  it("keeps a STATE line attached to its own block", () => {
    const doc = setBlockStates(
      designFromOutput("### REQ-001: t\nDESIGN: y\nMANUAL: do a thing - Setup - after deploy"),
      { "REQ-001": "open" },
    );
    const block = parseBlocks(doc).blocks[0];
    expect(block.design).toContain("STATE: open");
  });
});

describe("duplicate requirement blocks", () => {
  const DUPE = [
    "### REQ-001: first copy",
    "DESIGN: draft",
    "",
    "### REQ-002: other",
    "DESIGN: b",
    "",
    "### REQ-001: second copy",
    "DESIGN: final",
  ].join("\n");

  it("are reported", () => {
    expect(duplicateBlocks(DUPE)).toEqual(["REQ-001"]);
  });

  it("collapse to the copy the agent finished with", () => {
    const p = parseBlocks(DUPE);
    expect(p.blocks.map((b) => b.id)).toEqual(["REQ-001", "REQ-002"]);
    expect(p.blocks[0].design).toContain("final");
    expect(p.blocks[0].design).not.toContain("draft");
  });
});

describe("placeFindings", () => {
  it("files a finding under every requirement it references", () => {
    const r = placeFindings(DESIGN, rec(1, [f("F37", ["REQ-001", "REQ-003"])]));
    const blocks = parseBlocks(r.text).blocks;
    expect(blocks[0].lineage).toContain("F37");
    expect(blocks[1].lineage).toBe("");
    expect(blocks[2].lineage).toContain("F37");
    expect(r.unassigned).toHaveLength(0);
  });

  it("keeps every round rather than overwriting the last", () => {
    // design-v2.md lost F1-F22 because writeReview dropped the previous review
    const one = placeFindings(DESIGN, rec(1, [f("F1", ["REQ-001"])])).text;
    const two = placeFindings(one, rec(2, [f("F9", ["REQ-001"])])).text;
    expect(two).toContain("F1");
    expect(two).toContain("F9");
    expect(two).toContain("##### R1 reviewer");
    expect(two).toContain("##### R2 reviewer");
  });

  it("surfaces a finding that matches no block instead of dropping it", () => {
    const r = placeFindings(DESIGN, rec(1, [f("F5", [])]));
    expect(r.unassigned.map((x) => x.id)).toEqual(["F5"]);
  });
});

describe("state", () => {
  it("stamps and reads back each block state", () => {
    const t = setBlockStates(DESIGN, {
      "REQ-001": "approved",
      "REQ-002": "approved-objected",
      "REQ-003": "clean",
    });
    expect(t).toContain("STATE: approved - reviewer objects");
    expect(blockStates(t)).toEqual({
      "REQ-001": "approved",
      "REQ-002": "approved-objected",
      "REQ-003": "clean",
    });
  });

  it("updates an existing STATE line rather than adding a second", () => {
    const once = setBlockStates(DESIGN, { "REQ-001": "open" });
    const twice = setBlockStates(once, { "REQ-001": "approved" });
    expect(twice.match(/STATE:/g)).toHaveLength(1);
    expect(blockStates(twice)["REQ-001"]).toBe("approved");
  });
});

describe("droppedBlocks", () => {
  it("catches a revision that loses requirements", () => {
    const shrunk = DESIGN.split("### REQ-003")[0];
    expect(droppedBlocks(DESIGN, shrunk)).toEqual(["REQ-003"]);
  });

  it("is silent when nothing is lost", () => {
    expect(droppedBlocks(DESIGN, `${DESIGN}\n\n### REQ-004: new\nDESIGN: x`)).toEqual([]);
  });
});

/** Run 9d512b43-a36 F36: a design field written AFTER a RESPONSE line was
 * swallowed into the response text and filed as history, so the edit was lost.
 * REQ-023 and REQ-024 kept their old DEPENDS-ON. */
describe("fields and responses in any order", () => {
  const d = (body: string) =>
    extractDelta(["=== DELTA START ===", "### REQ-023: Allocate", body, "=== DELTA END ==="].join("\n"));

  it("recognises a field written after a response", () => {
    const b = d(
      [
        "RESPONSE F2 ACCEPTED - FIXED: split the engine",
        "DEPENDS-ON: REQ-019, REQ-021",
        "EFFORT: 5d",
      ].join("\n"),
    ).blocks[0];
    expect(b.design).toContain("DEPENDS-ON: REQ-019, REQ-021");
    expect(b.design).toContain("EFFORT: 5d");
    expect(b.responses).toContain("F2 ACCEPTED - FIXED");
    expect(b.responses).not.toContain("DEPENDS-ON");
  });

  it("keeps a multi-line response body with its response", () => {
    const b = d(
      ["DESIGN: x", "RESPONSE F1 CHECKED: read Foo.cls:10", "  and it says nothing of the sort"].join("\n"),
    ).blocks[0];
    expect(b.responses).toContain("nothing of the sort");
    expect(b.design).toBe("DESIGN: x");
  });
});

/** Run 9d512b43-a36 F29: "only the fields you are changing" was read as "a diff
 * of the prose inside the field", and 21 of 34 blocks lost their design. */
describe("a field that defers to text it does not carry", () => {
  it("is detected", () => {
    expect(deferringFields("DESIGN: (unchanged core algorithm) with step 8 corrected: x")).toEqual(["DESIGN"]);
    expect(deferringFields("DESIGN: Create the mapping object as previously designed")).toEqual(["DESIGN"]);
    expect(deferringFields("EFFORT: 5d\nDESIGN: a full and complete description")).toEqual([]);
  });

  it("does not fire on ordinary prose", () => {
    expect(deferringFields("DESIGN: the balance is unchanged by a reversal, which is the point")).toEqual([]);
  });
});

/** Both of these appeared in a real revision and both slipped past the first
 * version of the guard: one used a composite label, the other said "cited"
 * rather than "designed". */
describe("a field that only gestures at content", () => {
  it("catches wordings the fixed phrases miss", () => {
    expect(deferringFields("EVIDENCE: `getContext` as previously cited.")).toEqual(["EVIDENCE"]);
    expect(deferringFields("STATUS: unchanged, see current document.")).toEqual(["STATUS"]);
    expect(deferringFields("DESIGN: same as before")).toEqual(["DESIGN"]);
    expect(deferringFields("PENDING: no change from the previous revision")).toEqual(["PENDING"]);
  });

  it("leaves a real design that happens to use the word alone", () => {
    const real =
      "DESIGN: the reversal pass restores Invoiced_Amount__c and leaves Funded_Amount__c " +
      "unchanged, because the funded total is the contract's and only the invoiced side moves. " +
      "recomputeStatus then derives Status__c from the two, so a reversal that frees capacity " +
      "un-sets Fully Consumed rather than leaving a one-way flip.";
    expect(deferringFields(real)).toEqual([]);
  });
});
