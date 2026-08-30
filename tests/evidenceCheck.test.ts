import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkEvidence, evidenceNote } from "@/lib/workflows/evidenceCheck";

/** The largest single class of review finding, across every run measured, is
 * the design asserting something about the org that is not true. Existence is
 * arithmetic, so it is checked rather than reviewed. */
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dhruva-ev-"));
  const classes = path.join(root, "force-app/main/default/classes");
  const objects = path.join(root, "force-app/main/default/objects/Contract__c/fields");
  fs.mkdirSync(classes, { recursive: true });
  fs.mkdirSync(objects, { recursive: true });
  fs.writeFileSync(path.join(classes, "ContractSearchController.cls"), "// x");
  fs.writeFileSync(path.join(objects, "Contract_Status__c.field-meta.xml"), "<x/>");
  fs.writeFileSync(
    path.join(root, "force-app/main/default/objects/Contract__c/Contract__c.object-meta.xml"),
    "<x/>",
  );
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const block = (evidence: string) =>
  ["### REQ-001: Search", "STATUS: PARTIAL", `EVIDENCE: ${evidence}`, "DESIGN: something", "EFFORT: 1d"].join("\n");

describe("checkEvidence", () => {
  it("passes components that exist", async () => {
    const r = await checkEvidence(root, block("`ContractSearchController` and `Contract_Status__c`"));
    expect(r.missing).toEqual([]);
    expect(r.checked).toBe(2);
  });

  /** The reviewer reported this as a CRITICAL finding after a 15-minute pass:
   * "the allocation engine has no input data - no invoice service-line object
   * exists". A grep settles it. */
  it("catches a cited object this project does not have", async () => {
    const r = await checkEvidence(root, block("lines come from `Invoice_Line_Item__c`"));
    expect(r.missing).toEqual([{ req: "REQ-001", name: "Invoice_Line_Item__c" }]);
    expect(evidenceNote(r)).toContain("Invoice_Line_Item__c (REQ-001)");
  });

  it("only judges EVIDENCE - DESIGN may name what it intends to create", async () => {
    const md = [
      "### REQ-001: Search",
      "EVIDENCE: `ContractSearchController`",
      "DESIGN: add `FundAllocationEngineService` and `Sub_Budget_Mapping__c`",
    ].join("\n");
    const r = await checkEvidence(root, md);
    expect(r.missing).toEqual([]);
  });

  /** A checker that cries wolf is worse than none in a pipeline already
   * fighting noise: these all appeared in real EVIDENCE fields. */
  it("ignores shapes it cannot judge", async () => {
    const r = await checkEvidence(
      root,
      block(
        "`SELECT` ... `ORDER` BY with `WITH` `USER_MODE`, constants `LIST_COLUMNS` and " +
          "`HISTORY_COLUMNS`, picklist values `Draft` and `Funded`, `Program_Type__r`, " +
          "`Planned_Unit__History`, `NavigationMixin`, `CreatedById`",
      ),
    );
    expect(r.missing).toEqual([]);
    expect(r.checked).toBe(0);
  });

  it("reports the same miss once per requirement, not once per mention", async () => {
    const r = await checkEvidence(root, block("`Missing_Thing__c` and again `Missing_Thing__c`"));
    expect(r.missing).toHaveLength(1);
  });

  it("says nothing when there was nothing checkable", async () => {
    expect(evidenceNote({ missing: [], duplicated: [], checked: 0 })).toBe("");
  });

  it("says so when everything checked out", async () => {
    expect(evidenceNote({ missing: [], duplicated: [], checked: 12 })).toContain("all 12 cited component(s) exist");
  });
});

/** Run d0e4f7bc-1d6: a corrupted glob - two prompts spliced together by
 * parallel sub-agents - produced "No dedicated Subcontractor detail LWC
 * exists", and the design set out to build `subcontractorDetail`, which the
 * repository already contains under exactly that name. Absence of evidence
 * taken for evidence of absence, for the third time in one session. */
describe("a design that proposes building what already exists", () => {
  it("is caught", async () => {
    const md = [
      "### REQ-034: View Subcontractor detail",
      "STATUS: NEW",
      "EVIDENCE: No Subcontractor detail LWC exists.",
      "DESIGN: (1) Build a new LWC `ContractSearchController` following the same pattern.",
    ].join("\n");
    const r = await checkEvidence(root, md);
    expect(r.duplicated).toEqual([{ req: "REQ-034", name: "ContractSearchController" }]);
    expect(evidenceNote(r)).toContain("ALREADY EXISTS");
  });

  it("says nothing about a component it genuinely has to create", async () => {
    const md = [
      "### REQ-020: Allocation engine",
      "DESIGN: Create a new Apex service `FundAllocationEngineService` with two methods.",
    ].join("\n");
    expect((await checkEvidence(root, md)).duplicated).toEqual([]);
  });

  it("does not fire on an existing component the design merely modifies", async () => {
    const md = [
      "### REQ-001: Search",
      "DESIGN: Re-declare `ContractSearchController` with sharing and add a status predicate.",
    ].join("\n");
    expect((await checkEvidence(root, md)).duplicated).toEqual([]);
  });
});

/** A first cut matched any backticked name near a creation verb and flagged six
 * things on a real design, five of them wrong. These are the five. */
describe("the already-exists check does not cry wolf", () => {
  const noise = [
    "### REQ-007: Invoices",
    "DESIGN: new fields on `Contract__c` carry the PO number.",
    "### REQ-011: Revenue",
    "DESIGN: add a matching validation rule on `Contract__c`.",
    "### REQ-022: Allocation",
    "DESIGN: create an in-memory `Contract__c` row for the preview.",
    "### REQ-024: Amounts",
    "DESIGN: increment the same two fields by the new `Contract_Status__c`.",
  ].join("\n");

  it("ignores a name the design merely attaches to", async () => {
    expect((await checkEvidence(root, noise)).duplicated).toEqual([]);
  });

  it("still catches an artifact named by its type", async () => {
    const real = [
      "### REQ-034: Subcontractor detail",
      "DESIGN: (1) Build a new LWC `ContractSearchController` on the record page.",
    ].join("\n");
    expect((await checkEvidence(root, real)).duplicated).toEqual([
      { req: "REQ-034", name: "ContractSearchController" },
    ]);
  });
});
