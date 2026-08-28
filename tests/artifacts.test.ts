import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  designFromOutput,
  madeProgress,
  openFindings,
  splitArtifact,
  writeDesign,
  writeReview,
} from "@/lib/workflows/artifacts";
import type { Finding } from "@/lib/findings";

const f = (id: string, severity: Finding["severity"], title = "t"): Finding => ({
  id,
  severity,
  refs: [],
  title,
  where: "",
  problem: "",
  fix: "",
});

const ARTIFACT = [
  "OVERVIEW paragraph.",
  "",
  "### REQ-001: something",
  "DESIGN: do the thing",
  "",
  "## Review",
  "",
  "- Verdict: needs_work",
  "- Round: 1",
  "",
  "### Findings",
  "",
  "#### F1 (critical): Write path contradicts its own FLS model",
  "- Where: REQ-009",
  "",
  "## Revision log",
  "",
  "- Round 1: needs_work, 1 open (1 critical)",
].join("\n");

describe("section ownership", () => {
  it("splits the agent's design from the engine's two sections", () => {
    const p = splitArtifact(ARTIFACT);
    expect(p.design).toContain("### REQ-001");
    expect(p.design).not.toContain("## Review");
    expect(p.design).not.toContain("## Revision log");
    expect(p.review).toContain("Verdict: needs_work");
    expect(p.review).not.toContain("## Revision log");
    expect(p.log).toContain("Round 1: needs_work");
  });

  it("treats a file with no review as all design", () => {
    const p = splitArtifact("### REQ-001: only a design\nDESIGN: x");
    expect(p.design).toContain("REQ-001");
    expect(p.review).toBe("");
    expect(p.log).toBe("");
  });

  it("reads the open findings back out of the artifact", () => {
    const open = openFindings(ARTIFACT);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe("F1");
    expect(open[0].severity).toBe("critical");
  });

  it("does not count a finding already marked RESOLVED as open", () => {
    const done = ARTIFACT.replace(
      "#### F1 (critical): Write path",
      "#### F1 (critical): RESOLVED Write path",
    );
    expect(openFindings(done)).toHaveLength(0);
  });
});

/** The stop condition. On run 029f2a49 round 2 to 3 moved criticals 4 to 5 and
 * closed nothing, and the loop spent the third round anyway. */
describe("progress detection", () => {
  const round = (n: number, findings: Finding[], closed: string[] = []) =>
    ({ round: n, verdict: "needs_work" as const, findings, closed });

  it("counts the first round as progress", () => {
    expect(madeProgress(null, round(1, [f("F1", "critical")]))).toBe(true);
  });

  it("counts a closed finding as progress", () => {
    const prev = round(1, [f("F1", "critical"), f("F2", "critical")]);
    const next = round(2, [f("F2", "critical"), f("F3", "critical")], ["F1"]);
    expect(madeProgress(prev, next)).toBe(true);
  });

  it("counts fewer criticals as progress", () => {
    const prev = round(1, [f("F1", "critical"), f("F2", "critical")]);
    const next = round(2, [f("F1", "critical"), f("F9", "important")]);
    expect(madeProgress(prev, next)).toBe(true);
  });

  it("calls the observed round-2-to-3 transition a STALL", () => {
    // 4 criticals -> 5, nothing closed, roughly the same finding count
    const prev = round(2, [
      f("F1", "critical"), f("F2", "critical"), f("F3", "critical"), f("F4", "critical"),
      ...Array.from({ length: 11 }, (_, i) => f(`F${i + 5}`, "important")),
    ]);
    const next = round(3, [
      f("F1", "critical"), f("F2", "critical"), f("F3", "critical"), f("F4", "critical"),
      f("F5", "critical"),
      ...Array.from({ length: 11 }, (_, i) => f(`F${i + 6}`, "important")),
    ]);
    expect(madeProgress(prev, next)).toBe(false);
  });

  it("calls an identical round a stall", () => {
    const same = [f("F1", "critical"), f("F2", "important")];
    expect(madeProgress(round(1, same), round(2, same))).toBe(false);
  });
});

/** step.output is the raw CLI transcript. Writing it verbatim would hand the
 * next rework its own terminal log to "reproduce exactly". */
describe("lifting the design out of the transcript", () => {
  const TRANSCRIPT = [
    '[engine] model requested: claude-sonnet-5 - your "design" role setting',
    "● Read prompt-029f2a49-analyse.txt                     6s",
    "  │ .dhruva/tmp/prompt-029f2a49-analyse.txt",
    "  └ 1 line read",
    "",
    "OVERVIEW: the approach in one paragraph.",
    "",
    "### REQ-001: Tab visibility",
    "STATUS: ALREADY IMPLEMENTED",
    "EFFORT: 0d",
    "",
    "=== STEP OUTCOME ===",
    "SUMMARY: designed it.",
    "=== END OUTCOME ===",
    "",
    "Changes    +0 -0",
    "AI Credits 177 (8m 20s)",
    "[exit 0]",
  ].join("\n");

  it("keeps the overview and the REQ blocks", () => {
    const d = designFromOutput(TRANSCRIPT);
    expect(d).toContain("OVERVIEW: the approach");
    expect(d).toContain("### REQ-001: Tab visibility");
    expect(d).toContain("EFFORT: 0d");
  });

  it("drops the banner, the tool trace and the run trailer", () => {
    const d = designFromOutput(TRANSCRIPT);
    expect(d).not.toContain("[engine]");
    expect(d).not.toContain("Read prompt-");
    expect(d).not.toContain("1 line read");
    expect(d).not.toContain("STEP OUTCOME");
    expect(d).not.toContain("AI Credits");
    expect(d).not.toContain("[exit 0]");
  });

  it("returns empty when the output is nothing but trace", () => {
    // the engine uses this to leave the previous design on disk rather than
    // blanking the artifact
    const traceOnly = "[engine] model requested: x\n● Read a.cls\n[exit 1]";
    expect(designFromOutput(traceOnly)).toBe("");
  });

  it("survives output with no outcome block", () => {
    expect(designFromOutput("### REQ-001: x\nDESIGN: y")).toContain("REQ-001");
  });
});

/** The main file is the CURRENT design; every version it replaced is kept
 * beside it, so a rework can be diffed against what it was meant to revise. */
describe("design versions are kept, not overwritten", () => {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "dhruva-art-"));
  const rel = "d/sd-RUN1-design.md";
  const crit = (id: string): Finding => f(id, "critical");

  it("archives each superseded version and keeps the latest in place", async () => {
    const root = mk();
    await writeDesign(root, rel, "### REQ-001: v1");
    await writeDesign(root, rel, "### REQ-001: v2");
    await writeDesign(root, rel, "### REQ-001: v3");
    const dir = path.join(root, "d");
    expect(fs.readdirSync(dir).sort()).toEqual([
      "sd-RUN1-design-v1.md",
      "sd-RUN1-design-v2.md",
      "sd-RUN1-design.md",
    ]);
    expect(fs.readFileSync(path.join(dir, "sd-RUN1-design-v1.md"), "utf8")).toContain("v1");
    expect(fs.readFileSync(path.join(dir, "sd-RUN1-design.md"), "utf8")).toContain("v3");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes no archive on the first pass", async () => {
    const root = mk();
    await writeDesign(root, rel, "### REQ-001: only");
    expect(fs.readdirSync(path.join(root, "d"))).toEqual(["sd-RUN1-design.md"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accumulates one revision-log row per round and keeps the design", async () => {
    const root = mk();
    await writeDesign(root, rel, "### REQ-001: v1");
    await writeReview(root, rel, { round: 1, verdict: "needs_work", findings: [crit("F1")], closed: [] });
    await writeDesign(root, rel, "### REQ-001: v2");
    await writeReview(root, rel, { round: 2, verdict: "pass", findings: [], closed: ["F1"] });
    const cur = fs.readFileSync(path.join(root, rel), "utf8");
    expect(cur).toContain("### REQ-001: v2");
    expect(cur.match(/^- Round \d/gm)).toHaveLength(2);
    expect(cur).toContain("- Verdict: pass");
    expect(cur).toContain("closed F1");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
