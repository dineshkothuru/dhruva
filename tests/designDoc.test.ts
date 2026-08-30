import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractDelta, type ReviewRecord } from "@/lib/workflows/artifacts";
import {
  applyDelta,
  foldDecision,
  foldReview,
  fromMarkdown,
  fixableOpen,
  load,
  awaitingDecision,
  parkable,
  parkBlocks,
  recordCards,
  recordDecision,
  renderApproved,
  recordReview,
  recomputeStates,
  render,
  renderChanges,
  renderFindings,
  renderHistory,
  renderPending,
  save,
  writeUpdate,
} from "@/lib/workflows/designDoc";
import type { Finding } from "@/lib/findings";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "dhruva-doc2-"));
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

const MD = [
  "# Design",
  "",
  "## OVERVIEW",
  "Not greenfield.",
  "",
  "### REQ-001: Search",
  "BRD-REF: Feature 1, US-1",
  "STATUS: PARTIAL",
  "EVIDENCE: `Foo.cls:10`",
  "DESIGN: original one",
  "EFFORT: 1d",
  "",
  "### REQ-002: Details",
  "STATUS: NEW",
  "DESIGN: original two",
].join("\n");

const delta = (body: string) => extractDelta(`=== DELTA START ===\n${body}\n=== DELTA END ===`);

describe("the document is state, the markdown is a view", () => {
  it("round-trips without drifting", () => {
    const once = render(fromMarkdown(MD));
    const twice = render(fromMarkdown(once));
    expect(twice).toBe(once);
  });

  it("keeps every field of every block", () => {
    const doc = fromMarkdown(MD);
    expect(doc.blocks.map((b) => b.id)).toEqual(["REQ-001", "REQ-002"]);
    const out = render(doc);
    for (const line of ["BRD-REF:", "STATUS:", "EVIDENCE:", "DESIGN: original one", "EFFORT: 1d"]) {
      expect(out).toContain(line);
    }
  });

  /** The failure that killed run c10adbb1-2fb: the engine renders a finding as
   * "#### F73 (nit): ...", the reviewer copies that style into its own answer,
   * and the engine's reader goes blind. It cannot happen when the engine never
   * reads its own rendering. */
  it("does not recover its own state from the rendering", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F1", ["REQ-001"])]));
    // the design carries the NUMBER; the detail lives in its own register
    expect(render(doc)).toContain("OPEN FINDINGS: F1");
    expect(renderFindings(doc)).toContain("#### F1".replace("####", "###"));
    // and the state is unaffected by how either view happens to be written
    expect(doc.findings[0].status).toBe("open");
    expect(doc.blocks[0].state).toBe("open");
    expect(doc.blocks[1].state).toBe("clean");
  });
});

/** Round 3 of run c10adbb1-2fb reported 28 findings closed when 33 existed;
 * round 7 reported 39. Any closure reads as progress, so the loop could never
 * stall and ran eight rounds over three hours. */
describe("the finding ledger", () => {
  it("never closes more than was open", () => {
    const doc = fromMarkdown(MD);
    let open: string[] = [];
    for (let round = 1; round <= 7; round++) {
      const raised = [f(`F${round}0`, ["REQ-001"]), f(`F${round}1`, ["REQ-002"])];
      const closing = open.slice(0, 1);
      const r = rec(round, raised, closing);
      recordReview(doc, r);
      expect(r.closed.length).toBeLessThanOrEqual(open.length);
      open = [...doc.openFindings];
    }
    // 14 raised, 6 closed across rounds 2-7
    expect(doc.openFindings).toHaveLength(8);
  });

  it("a finding leaves the open set exactly once", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F1", ["REQ-001"]), f("F2", ["REQ-001"])]));
    expect(doc.openFindings.sort()).toEqual(["F1", "F2"]);
    recordReview(doc, rec(2, [f("F2", ["REQ-001"])], ["F1"]));
    expect(doc.openFindings).toEqual(["F2"]);
    recordReview(doc, rec(3, [], ["F2"]));
    expect(doc.openFindings).toEqual([]);
  });
});

describe("writeUpdate", () => {
  it("authors, then splices a delta without touching other blocks", async () => {
    const root = mk();
    expect((await writeUpdate(root, rel, MD, 1, extractDelta(MD))).mode).toBe("authored");
    const w = await writeUpdate(
      root,
      rel,
      "",
      2,
      delta("### REQ-002: Details\nDESIGN: revised two"),
    );
    expect(w.mode).toBe("delta");
    expect(w.applied).toEqual(["REQ-002"]);
    const cur = read(root);
    expect(cur).toContain("DESIGN: revised two");
    expect(cur).toContain("DESIGN: original one");
    expect(cur).toContain("EVIDENCE: `Foo.cls:10`");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps fields a delta does not mention", async () => {
    const root = mk();
    await writeUpdate(root, rel, MD, 1, extractDelta(MD));
    await writeUpdate(root, rel, "", 2, delta("### REQ-001: Search\nDESIGN: only this changed"));
    const cur = read(root);
    expect(cur).toContain("BRD-REF: Feature 1, US-1");
    expect(cur).toContain("STATUS: PARTIAL");
    expect(cur).toContain("EVIDENCE: `Foo.cls:10`");
    expect(cur).toContain("only this changed");
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A pass that forgets it already wrote a design re-authors from scratch. */
  it("cannot lose history or a requirement to a whole re-send", async () => {
    const root = mk();
    await writeUpdate(root, rel, MD, 1, extractDelta(MD));
    await foldReview(root, rel, "VERDICT: BLOCKED", 1, [f("F9", ["REQ-002"])], {
      resolved: new Set(),
      partial: new Set(),
      stillOpen: new Set(),
    });
    const short = MD.split("### REQ-002")[0]; // forgot REQ-002 entirely
    const w = await writeUpdate(root, rel, short, 2, extractDelta(short));
    expect(w.mode).toBe("merged");
    expect(w.kept).toEqual(["REQ-002"]);
    const cur = read(root);
    expect(cur).toContain("REQ-002");
    expect(cur).toContain("F9");
    expect(cur).toContain("- Round 1:");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("archives the version it replaced", async () => {
    const root = mk();
    await writeUpdate(root, rel, MD, 1, extractDelta(MD));
    await writeUpdate(root, rel, "", 2, delta("### REQ-001: Search\nDESIGN: v2"));
    expect(fs.existsSync(path.join(root, "docs/design-v1.md"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a delta with no design to apply it to", async () => {
    const root = mk();
    const w = await writeUpdate(root, rel, "", 1, delta("### REQ-001: x\nDESIGN: y"));
    expect(w.mode).toBe("refused");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("state and decisions", () => {
  it("only a human approval freezes a block, and the words are kept verbatim", async () => {
    const root = mk();
    await writeUpdate(root, rel, MD, 1, extractDelta(MD));
    await foldDecision(root, rel, {
      action: "approved",
      text: "Ship it, but confirm ownership with Portal 1.",
      freeze: true,
    });
    const doc = (await load(root, rel))!;
    expect(doc.blocks.every((b) => b.state === "approved")).toBe(true);
    expect(read(root)).toContain("confirm ownership with Portal 1");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a reviewer objecting to an approved block does not reopen it", async () => {
    const root = mk();
    await writeUpdate(root, rel, MD, 1, extractDelta(MD));
    await foldDecision(root, rel, { action: "approved", text: "ok", freeze: true });
    await foldReview(root, rel, "VERDICT: BLOCKED", 2, [f("F41", ["REQ-001"])], {
      resolved: new Set(),
      partial: new Set(),
      stillOpen: new Set(),
    });
    const doc = (await load(root, rel))!;
    expect(doc.blocks.find((b) => b.id === "REQ-001")!.state).toBe("approved-objected");
    expect(doc.blocks.find((b) => b.id === "REQ-002")!.state).toBe("approved");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("adopts a design written before the state file existed", async () => {
    const root = mk();
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, rel), MD, "utf8");
    const doc = (await load(root, rel))!;
    expect(doc.blocks.map((b) => b.id)).toEqual(["REQ-001", "REQ-002"]);
    await save(root, rel, doc);
    expect(fs.existsSync(path.join(root, "docs/design.json"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/** The UX design goes through the same store, and its blocks are UX-n, which
 * the requirement parser does not recognise. It must survive untouched rather
 * than be reshaped by a parser that was never meant for it. */
describe("a document with no requirement blocks", () => {
  const UX = ["# UX design", "", "### UX-1: Search screen", "LAYOUT: two columns", "STATES: loading, empty, error"].join("\n");

  it("round-trips its content unchanged", async () => {
    const root = mk();
    const w = await writeUpdate(root, "docs/ux.md", UX, 1, extractDelta(UX));
    expect(w.mode).toBe("authored");
    const out = read(root, "docs/ux.md");
    expect(out).toContain("### UX-1: Search screen");
    expect(out).toContain("LAYOUT: two columns");
    expect(out).toContain("STATES: loading, empty, error");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("still records its review rounds, without losing the design", async () => {
    const root = mk();
    await writeUpdate(root, "docs/ux.md", UX, 1, extractDelta(UX));
    await foldReview(root, "docs/ux.md", "VERDICT: BLOCKED", 1, [f("F1", ["UX-1"])], {
      resolved: new Set(),
      partial: new Set(),
      stillOpen: new Set(),
    });
    const out = read(root, "docs/ux.md");
    expect(out).toContain("### UX-1: Search screen");
    expect(out).toContain("F1");
    expect(out).toContain("## Review");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/** Run a9f88c51-fa2: the design pass investigated out loud first - 472 lines
 * of notes across five areas - then wrote `# OVERVIEW` and the real design.
 * All 60 KB became the document's opening and would have been re-sent to both
 * agents on every round. */
describe("investigation notes above the overview", () => {
  const NOTES = [
    "Now let me investigate the actual repo state before designing.",
    "",
    "### 7. Apex classes",
    "ContractSearchController, RevenuePriorityController, ...",
    "",
    "### 12. Permission sets referencing Contract objects",
    "Archive_Extra_Permission grants read on many objects.",
    "",
    "# OVERVIEW",
    "This is not greenfield; the finance surface largely exists.",
    "",
    "### REQ-001: Search",
    "DESIGN: x",
  ].join("\n");

  it("are dropped, and the real overview kept", () => {
    const doc = fromMarkdown(NOTES);
    expect(doc.preamble).toContain("# OVERVIEW");
    expect(doc.preamble).toContain("not greenfield");
    expect(doc.preamble).not.toContain("investigate the actual repo state");
    expect(doc.preamble).not.toContain("Apex classes");
    expect(doc.blocks.map((b) => b.id)).toEqual(["REQ-001"]);
  });

  it("leave a document that has no overview heading alone", () => {
    const doc = fromMarkdown("Some preamble prose.\n\n### REQ-001: t\nDESIGN: y");
    expect(doc.preamble).toContain("Some preamble prose.");
  });
});

/** Run 9d512b43-a36: 35 findings became 106 copies - one filed into 17 blocks -
 * and 126 KB of a 216 KB document was duplicated review text, re-sent to both
 * agents every round. */
describe("a finding that names several requirements", () => {
  it("is stored once in the register and only its number reaches each block", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F29", ["REQ-002", "REQ-001"])]));
    expect(doc.findings).toHaveLength(1);
    expect(doc.findings[0].refs.sort()).toEqual(["REQ-001", "REQ-002"]);
    const md = render(doc);
    // the detail appears nowhere in the design - only the number, on both rows
    expect(md).not.toContain("- Problem: wrong");
    expect(md.match(/OPEN FINDINGS: F29/g)).toHaveLength(2);
    // and once, in full, in its own document
    expect(renderFindings(doc)).toContain("F29 (critical)");
    expect(renderFindings(doc).match(/### F29/g)).toHaveLength(1);
  });

  it("still opens every block it names", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F29", ["REQ-001", "REQ-002"])]));
    expect(doc.blocks.every((b) => b.state === "open")).toBe(true);
  });

  it("counts as one open finding, not one per block", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F29", ["REQ-001", "REQ-002"])]));
    expect(doc.openFindings).toEqual(["F29"]);
  });
});

/** One requirement can carry several findings. Fixing one is not the
 * requirement being cleared - the old rule asked only "did THIS round name this
 * block?", so a block carrying F12 open since round 1 turned clean in round 2
 * the moment the reviewer did not re-mention it. */
describe("a requirement with more than one finding", () => {
  it("stays open until every one of them is closed", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F1", ["REQ-001"]), f("F2", ["REQ-001"])]));
    expect(doc.blocks[0].state).toBe("open");

    // round 2 closes F1 and says nothing at all about F2
    recordReview(doc, rec(2, [], ["F1"]));
    expect(doc.findings.find((x) => x.id === "F1")!.status).toBe("resolved");
    expect(doc.findings.find((x) => x.id === "F2")!.status).toBe("open");
    expect(doc.blocks[0].state).toBe("open");
    expect(render(doc)).toContain("OPEN FINDINGS: F2");

    // only when the last one goes does the requirement come clean
    recordReview(doc, rec(3, [], ["F2"]));
    expect(doc.blocks[0].state).toBe("clean");
    expect(render(doc)).toContain("OPEN FINDINGS: -");
  });

  it("shows what happened to it, round by round, on the block", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F1", ["REQ-001"])]));
    recordReview(doc, rec(2, [], ["F1"]));
    const md = render(doc);
    expect(md).toContain("R1: open F1");
    expect(md).toContain("R2: clean");
  });

  it("re-opens a finding the reviewer raises again", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F1", ["REQ-001"])]));
    recordReview(doc, rec(2, [], ["F1"]));
    expect(doc.blocks[0].state).toBe("clean");
    recordReview(doc, rec(3, [f("F1", ["REQ-001"])]));
    expect(doc.findings.find((x) => x.id === "F1")!.status).toBe("open");
    expect(doc.blocks[0].state).toBe("open");
    expect(doc.findings).toHaveLength(1);
  });

  it("keeps an approval the human gave, and flags the objection instead", () => {
    const doc = fromMarkdown(MD);
    for (const b of doc.blocks) b.state = "approved";
    recordReview(doc, rec(1, [f("F9", ["REQ-001"])]));
    expect(doc.blocks.find((b) => b.id === "REQ-001")!.state).toBe("approved-objected");
    expect(doc.blocks.find((b) => b.id === "REQ-002")!.state).toBe("approved");
    recomputeStates(doc);
    expect(doc.blocks.find((b) => b.id === "REQ-001")!.state).toBe("approved-objected");
  });
});

/** A reader wants to see what was designed, why it changed, and which version
 * was signed off - and an agent needs only the current design. Two views. */
describe("the design history", () => {
  it("keeps every version of a requirement, tagged with what drove it", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F24", ["REQ-001"])]));
    applyDelta(
      doc,
      delta(
        [
          "### REQ-001: Search",
          "DESIGN: split compute and persist",
          "RESPONSE F24 ACCEPTED - FIXED: split it",
        ].join("\n"),
      ),
      2,
    );
    const h = renderHistory(doc);
    expect(h).toContain("D1 - authored");
    expect(h).toContain("DESIGN: original one");
    expect(h).toContain("D2 - revised for F24");
    expect(h).toContain("split compute and persist");
    expect(h).toContain("<-- current");
  });

  it("marks the version the human approved", () => {
    const doc = fromMarkdown(MD);
    recordDecision(doc, { action: "approved", text: "ship it", freeze: true });
    const h = renderHistory(doc);
    expect(h).toContain("Approved at gate 1");
    expect(h).toContain("<-- APPROVED");
  });

  it("stays out of the document the agents are given", () => {
    const doc = fromMarkdown(MD);
    applyDelta(doc, delta(["### REQ-001: Search", "DESIGN: second version"].join("\n")), 2);
    const design = render(doc);
    expect(design).toContain("DESIGN: second version");
    expect(design).not.toContain("DESIGN: original one"); // superseded text is not re-sent
    expect(renderHistory(doc)).toContain("DESIGN: original one");
  });
});

describe("duplicate requirements", () => {
  it("collapse to the copy the agent finished with", () => {
    const dupe = `${MD}\n\n### REQ-001: Search\nDESIGN: the final one`;
    const doc = fromMarkdown(dupe);
    expect(doc.blocks.map((b) => b.id)).toEqual(["REQ-001", "REQ-002"]);
    expect(render(doc)).toContain("the final one");
    expect(render(doc)).not.toContain("original one");
  });

  it("a delta cannot introduce a second copy", () => {
    const doc = fromMarkdown(MD);
    applyDelta(doc, delta("### REQ-001: Search\nDESIGN: a\n\n### REQ-001: Search\nDESIGN: b"), 2);
    expect(doc.blocks.filter((b) => b.id === "REQ-001")).toHaveLength(1);
  });
});

/** A reviewer cannot judge whether a fix landed without seeing what moved. */
describe("what changed since the last review", () => {
  it("shows the fields that differ, WAS and NOW, with what drove them", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F24", ["REQ-001"])]));
    applyDelta(
      doc,
      delta(
        [
          "### REQ-001: Search",
          "DESIGN: split compute and persist",
          "RESPONSE F24 ACCEPTED - FIXED: split it",
        ].join("\n"),
      ),
      2,
    );
    const c = renderChanges(doc, 2);
    expect(c).toContain("Blocks revised in round 2: REQ-001");
    expect(c).toContain("answering F24");
    expect(c).toContain("WAS  DESIGN: original one");
    expect(c).toContain("NOW  DESIGN: split compute and persist");
    // untouched fields are not repeated
    expect(c).not.toContain("EFFORT: 1d");
  });

  it("says nothing when nothing moved", () => {
    const doc = fromMarkdown(MD);
    expect(renderChanges(doc, 3)).toBe("");
  });

  it("reports a field the revision removed", () => {
    const doc = fromMarkdown(MD);
    doc.blocks[0].revisions.push({
      round: 2,
      drivenBy: [],
      fields: doc.blocks[0].fields.filter((x) => x.label !== "EFFORT"),
    });
    expect(renderChanges(doc, 2)).toContain("REMOVED EFFORT: 1d");
  });
});

/** The boundary case. A design that says "Portal 1 must confirm the invoice
 * line shape" is conditional on an answer nobody has - and on run d0e4f7bc-1d6
 * four such blocks reached the human gate as `clean`, because no reviewer
 * finding happened to name them and OPEN-CONFIRMED was prose the engine never
 * read. Ready-to-sign-off is the one thing they were not. */
describe("a design's own open question holds its block", () => {
  const withQuestion = (q: string) =>
    MD.replace("DESIGN: original one", `OPEN-CONFIRMED: ${q}
DESIGN: original one`);

  it("reads the question off the block, and ignores an empty one", () => {
    const doc = fromMarkdown(withQuestion("Portal 1 must confirm the invoice line shape"));
    expect(awaitingDecision(doc.blocks[0])).toBe("Portal 1 must confirm the invoice line shape");
    expect(awaitingDecision(fromMarkdown(withQuestion("-")).blocks[0])).toBeNull();
    expect(awaitingDecision(doc.blocks[1])).toBeNull();
  });

  it("keeps the block open with no finding against it", () => {
    const doc = fromMarkdown(withQuestion("Portal 1 must confirm the shape"));
    recomputeStates(doc);
    expect(doc.blocks[0].state).toBe("open");
    expect(doc.blocks[1].state).toBe("clean");
    const md = render(doc);
    expect(md).toContain("OPEN FINDINGS: -");
    expect(md).toContain("held by its own OPEN-CONFIRMED");
  });

  it("goes clean once the design settles it", () => {
    const doc = fromMarkdown(withQuestion("Portal 1 must confirm the shape"));
    applyDelta(doc, delta(["### REQ-001: Search", "OPEN-CONFIRMED: -"].join("\n")), 2);
    recomputeStates(doc);
    expect(doc.blocks[0].state).toBe("clean");
  });

  it("offers it at the gate, and hands the question over when parked", () => {
    const doc = fromMarkdown(withQuestion("Portal 1 must confirm the shape"));
    recomputeStates(doc);
    expect(parkable(doc).map((b) => b.id)).toEqual(["REQ-001"]);
    parkBlocks(doc, ["REQ-001"], 1);
    expect(renderPending(doc)).toContain("Portal 1 must confirm the shape");
    expect(doc.blocks[0].history.at(-1)?.note).toContain("the OPEN-CONFIRMED decision");
  });

  it("does not offer one that still has fixable work", () => {
    const doc = fromMarkdown(withQuestion("Portal 1 must confirm the shape"));
    recordReview(doc, rec(1, [f("F9", ["REQ-001"])]));
    expect(parkable(doc)).toEqual([]);
  });
});

/** The gate stopped being one verb for the whole run. Most cards are fine, two
 * are wrong, one carries a note - and the states to say that existed in the
 * document long before the gate could say them. */
describe("the human rules on requirements one at a time", () => {
  it("freezes what it signs, and keeps the person's own words", () => {
    const doc = fromMarkdown(MD);
    const r = recordCards(doc, 1, [
      { id: "REQ-001", verdict: "approve", note: "keep the LWC, we own that pattern" },
      { id: "REQ-002", verdict: "revise", note: "use a flow, not a trigger" },
    ]);
    expect(r).toEqual({ approved: ["REQ-001"], revising: ["REQ-002"] });
    expect(doc.blocks[0].state).toBe("approved");
    expect(doc.blocks[0].humanNote).toBe("keep the LWC, we own that pattern");
    expect(doc.blocks[1].state).toBe("open");

    // and the freeze is real: a later delta cannot rewrite the signed block
    const rep = applyDelta(doc, delta(["### REQ-001: Search", "DESIGN: something else"].join("\n")), 2);
    expect(rep.frozen).toEqual(["REQ-001"]);
    expect(render(doc)).toContain("DESIGN: original one");
  });

  it("says so when the human signs over an open objection", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [f("F9", ["REQ-001"])]));
    recordCards(doc, 1, [{ id: "REQ-001", verdict: "approve" }]);
    expect(doc.blocks[0].state).toBe("approved-objected");
    expect(renderApproved(doc)).toContain("APPROVED-OVER-OBJECTION: F9");
  });

  it("will not sign a card nobody ruled on, or one already parked", () => {
    const doc = fromMarkdown(MD);
    parkBlocks(doc, ["REQ-002"], 1);
    const r = recordCards(doc, 2, [{ id: "REQ-002", verdict: "approve" }]);
    expect(r.approved).toEqual([]);
    expect(doc.blocks[1].state).toBe("parked");
    expect(renderApproved(doc)).toContain("_Nothing is approved yet");
  });

  it("writes the signed design on its own, and it reads straight back", () => {
    const doc = fromMarkdown(MD);
    recordCards(doc, 1, [{ id: "REQ-001", verdict: "approve", note: "our pattern" }]);
    const md = renderApproved(doc);
    expect(md).toContain("### REQ-001: Search");
    expect(md).toContain("HUMAN-NOTE: our pattern");
    expect(md).not.toContain("REQ-002");        // unsigned work stays out
    expect(md).not.toContain("STATE:");         // no engine bookkeeping
    // the deliverable is also a valid input to a later run
    const back = fromMarkdown(md);
    expect(back.blocks.map((b) => b.id)).toEqual(["REQ-001"]);
  });
});

/** Partial delivery. Five unanswered questions should not hold an otherwise
 * finished epic: the blocked requirements keep their design and step aside so
 * the rest can be built. */
describe("parking what is blocked on a decision", () => {
  const decide = (id: string, refs: string[]): Finding => ({
    ...f(id, refs),
    fix: "confirm with Portal 1 what shape the invoice lines are\nNEEDS: decide - Portal 1 must answer",
  });

  it("offers only requirements blocked SOLELY on a decision", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [decide("F55", ["REQ-001"]), f("F9", ["REQ-002"])]));
    expect(parkable(doc).map((b) => b.id)).toEqual(["REQ-001"]);
  });

  it("will not park a requirement that still has fixable work", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [decide("F55", ["REQ-001"]), f("F9", ["REQ-001"])]));
    expect(parkable(doc)).toEqual([]);
  });

  it("keeps the design and the questions, out of the built document", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [decide("F55", ["REQ-001"])]));
    expect(parkBlocks(doc, ["REQ-001"], 1)).toEqual(["REQ-001"]);

    const design = render(doc);
    expect(design).not.toContain("REQ-001");     // not built from
    expect(design).toContain("REQ-002");         // the rest proceeds

    const pending = renderPending(doc);
    expect(pending).toContain("REQ-001: Search");
    expect(pending).toContain("Portal 1 must answer");
    expect(pending).toContain("DESIGN: original one"); // the work is kept
  });

  it("stops counting a parked requirement against convergence", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [decide("F55", ["REQ-001"]), f("F9", ["REQ-002"])]));
    expect(fixableOpen(doc).map((x) => x.id)).toEqual(["F9"]);
    parkBlocks(doc, ["REQ-001"], 1);
    recordReview(doc, rec(2, [], ["F9"]));
    expect(fixableOpen(doc)).toEqual([]);
  });

  it("is the human's decision - a later review does not un-park it", () => {
    const doc = fromMarkdown(MD);
    recordReview(doc, rec(1, [decide("F55", ["REQ-001"])]));
    parkBlocks(doc, ["REQ-001"], 1);
    recordReview(doc, rec(2, [f("F70", ["REQ-001"])]));
    expect(doc.blocks.find((b) => b.id === "REQ-001")!.state).toBe("parked");
  });
});
