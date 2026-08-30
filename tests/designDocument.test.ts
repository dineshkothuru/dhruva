import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  blockStates,
  mergeFull,
  recordHumanDecision,
  recordReview,
  statesAfterReview,
  writeDesignUpdate,
  type ReviewRecord,
} from "@/lib/workflows/artifacts";
import type { Finding } from "@/lib/findings";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "dhruva-doc-"));
const rel = "docs/design.md";
const read = (root: string, p = rel) => fs.readFileSync(path.join(root, p), "utf8");

const f = (id: string, refs: string[], severity: Finding["severity"] = "critical"): Finding => ({
  id,
  severity,
  refs,
  title: `${id} title`,
  where: "Some.cls:10",
  problem: "wrong",
  fix: "right",
});

const rec = (round: number, findings: Finding[], closed: string[] = []): ReviewRecord => ({
  round,
  verdict: findings.length ? "needs_work" : "pass",
  findings,
  closed,
});

const D1 = [
  "# Design",
  "",
  "### REQ-001: Search",
  "DESIGN: original one",
  "",
  "### REQ-002: Details",
  "DESIGN: original two",
  "",
  "### REQ-003: Allocate",
  "DESIGN: original three",
].join("\n");

const delta = (body: string) => `=== DELTA START ===\n${body}\n=== DELTA END ===`;

describe("writeDesignUpdate", () => {
  it("authors on the first pass and archives nothing", async () => {
    const root = mk();
    const w = await writeDesignUpdate(root, rel, D1, 1);
    expect(w.mode).toBe("authored");
    expect(fs.readdirSync(path.join(root, "docs"))).toEqual(["design.md"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a delta when no design exists to apply it to", async () => {
    const root = mk();
    const w = await writeDesignUpdate(root, rel, delta("### REQ-001: Search\nDESIGN: x"), 1);
    expect(w.mode).toBe("refused");
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("splices a delta, archives the version it replaced, and keeps the rest", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    const w = await writeDesignUpdate(
      root,
      rel,
      delta("### REQ-002: Details\nDESIGN: revised two"),
      2,
    );
    expect(w.mode).toBe("delta");
    expect(w.applied).toEqual(["REQ-002"]);
    const cur = read(root);
    expect(cur).toContain("DESIGN: revised two");
    expect(cur).toContain("DESIGN: original one");
    expect(cur).toContain("DESIGN: original three");
    expect(fs.existsSync(path.join(root, "docs/design-v1.md"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Run 1e3dc542-bbc round 4: the design was re-authored from scratch and
   * three rounds of accepted fixes went with it. The body carried the same 34
   * requirement ids, so counting ids would not have caught it - what it
   * destroyed was the history inside the blocks. */
  it("cannot lose review history to a whole design re-sent instead of a delta", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    await recordReview(root, rel, rec(1, [f("F24", ["REQ-002"])]));
    await writeDesignUpdate(
      root,
      rel,
      delta("### REQ-002: Details\nDESIGN: fixed\nRESPONSE F24 ACCEPTED - FIXED: split it"),
      2,
    );

    // the amnesiac round: a complete, freshly authored body, same ids, no history
    const w = await writeDesignUpdate(root, rel, D1, 3);

    expect(w.mode).toBe("merged");
    const cur = read(root);
    expect(cur).toContain("F24");
    expect(cur).toContain("F24 ACCEPTED - FIXED");
    expect(cur).toContain("##### R1 reviewer");
    expect(cur).toContain("##### D2 designer");
    expect(cur).toContain("- Round 1:");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps a requirement the re-sent body forgot, and says so", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    const short = D1.split("### REQ-003")[0];
    const w = await writeDesignUpdate(root, rel, short, 2);
    expect(w.kept).toEqual(["REQ-003"]);
    expect(read(root)).toContain("REQ-003");
    expect(w.note).toContain("REQ-003");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses an output that is not a design at all", async () => {
    const root = mk();
    const w = await writeDesignUpdate(root, rel, "   ", 1);
    expect(w.mode).toBe("refused");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("recordReview", () => {
  it("files findings inside their requirement and stamps every state", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    await recordReview(root, rel, rec(1, [f("F1", ["REQ-001", "REQ-003"])]));
    const cur = read(root);
    expect(cur).toContain("##### R1 reviewer");
    expect(blockStates(cur)).toEqual({
      "REQ-001": "open",
      "REQ-002": "clean",
      "REQ-003": "open",
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** design-v2.md's review section holds F23-F32 and F1-F22 are simply gone:
   * writeReview replaced the section every round instead of adding to it. */
  it("accumulates rounds instead of replacing the previous one", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    await recordReview(root, rel, rec(1, [f("F1", ["REQ-001"])]));
    await recordReview(root, rel, rec(2, [f("F9", ["REQ-002"])], ["F1"]));
    const cur = read(root);
    expect(cur).toContain("F1");
    expect(cur).toContain("F9");
    expect(cur.match(/^- Round \d/gm)).toHaveLength(2);
    expect(cur).toContain("closed F1");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("files a finding that names no requirement under the review section", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    const unassigned = await recordReview(root, rel, rec(1, [f("F5", [])]));
    expect(unassigned?.map((x) => x.id)).toEqual(["F5"]);
    expect(read(root)).toContain("## Review");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("leaves a document with no requirement blocks on the old path", async () => {
    // the UX design's blocks are UX-n, so nothing here should change for it
    const root = mk();
    await writeDesignUpdate(root, rel, "### UX-1: a screen\nDESIGN: x", 1);
    await recordReview(root, rel, rec(1, [f("F1", ["UX-1"])]));
    const cur = read(root);
    expect(cur).toContain("- Verdict: needs_work");
    expect(cur).toContain("F1");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null when there is no artifact to record against", async () => {
    const root = mk();
    expect(await recordReview(root, rel, rec(1, [f("F1", ["REQ-001"])]))).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("statesAfterReview", () => {
  it("moves an approved block to objected rather than reopening it", () => {
    const approved = [
      "### REQ-001: Search",
      "DESIGN: x",
      "STATE: approved",
      "",
      "### REQ-002: Details",
      "DESIGN: y",
      "STATE: approved",
    ].join("\n");
    const next = statesAfterReview(approved, rec(2, [f("F41", ["REQ-001"])]));
    expect(next["REQ-001"]).toBe("approved-objected");
    expect(next["REQ-002"]).toBe("approved");
  });

  it("returns an objected block to approved when the reviewer drops the objection", () => {
    const objected = ["### REQ-001: Search", "DESIGN: x", "STATE: approved - reviewer objects"].join("\n");
    expect(statesAfterReview(objected, rec(3, []))["REQ-001"]).toBe("approved");
  });
});

/** The decision used to live only in run.revisions: injected into the
 * designer's next prompt and then invisible - not in the document, not in the
 * UI, and never shown to the reviewer. */
describe("human decisions", () => {
  it("records the human's own words and freezes the blocks they approved", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    await recordReview(root, rel, rec(1, [f("F1", ["REQ-001"])]));
    await recordHumanDecision(root, rel, {
      action: "approved",
      text: "Ship it, but confirm ownership of Invoice_Line_Item__c with Portal 1.",
      approvedIds: ["REQ-001", "REQ-002", "REQ-003"],
    });
    const cur = read(root);
    expect(cur).toContain("## Human decisions");
    expect(cur).toContain("### Gate 1 - approved");
    expect(cur).toContain("confirm ownership of Invoice_Line_Item__c");
    expect(blockStates(cur)["REQ-001"]).toBe("approved");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("numbers each gate and never overwrites an earlier one", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    await recordHumanDecision(root, rel, { action: "revise", text: "use a flow, not a trigger" });
    await recordHumanDecision(root, rel, { action: "approved", text: "good now" });
    const cur = read(root);
    expect(cur).toContain("### Gate 1 - revision requested");
    expect(cur).toContain("### Gate 2 - approved");
    expect(cur).toContain("use a flow, not a trigger");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("survives every later write to the document", async () => {
    const root = mk();
    await writeDesignUpdate(root, rel, D1, 1);
    await recordHumanDecision(root, rel, { action: "revise", text: "split the service class" });
    // a later review round, a later delta, and a whole re-send
    await recordReview(root, rel, rec(2, [f("F2", ["REQ-002"])]));
    await writeDesignUpdate(root, rel, delta("### REQ-002: Details\nDESIGN: split"), 2);
    await writeDesignUpdate(root, rel, D1, 3);
    const cur = read(root);
    expect(cur).toContain("split the service class");
    expect(cur.match(/## Human decisions/g)).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does nothing when there is no document to record against", async () => {
    const root = mk();
    expect(await recordHumanDecision(root, rel, { action: "approved", text: "ok" })).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("mergeFull", () => {
  it("takes the incoming design fields and keeps the existing lineage", () => {
    const withHistory = `${D1}\n\n<!-- lineage -->\n\n##### R1 reviewer\n\n#### F1 (critical): x`;
    const m = mergeFull(withHistory, D1.replace("original three", "rewritten three"));
    expect(m.text).toContain("rewritten three");
    expect(m.text).toContain("F1 (critical)");
  });

  it("appends a genuinely new requirement", () => {
    const m = mergeFull(D1, `${D1}\n\n### REQ-004: New\nDESIGN: four`);
    expect(m.added).toEqual(["REQ-004"]);
    expect(m.text).toContain("REQ-004");
  });
});
