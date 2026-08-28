import path from "node:path";
import { promises as fs } from "node:fs";
import { parseFindings, type Finding } from "@/lib/findings";

/** The design artifact.
 *
 * A design used to live in `step.output`, which the rework wiped before
 * re-running - so the architect was told "this is a revision of your earlier
 * output" while that output no longer existed, and its prompt meanwhile ordered
 * a full authoring pass. It redrafted every round. Measured on run
 * 029f2a49-5dd: four designs, four reviews, ten of sixteen requirements flagged
 * in every single one, zero net progress.
 *
 * Now the design is a FILE. It survives the replay because nothing wipes it,
 * the rework reads its own previous work, and the reviewer's findings live in
 * the same document rather than in a side channel the reviewer never sees again.
 *
 * Section ownership is enforced here, not asked for in a prompt:
 *   the design      the agent writes it (lifted from the step's output)
 *   ## Review       the ENGINE writes it, parsed from the reviewer's stdout
 *   ## Revision log the ENGINE writes it, append-only
 *
 * The reviewer stays `readOnly` at the CLI - it never gets write access to the
 * document it is judging. */

const REVIEW_H = "## Review";
const LOG_H = "## Revision log";

export interface ReviewRecord {
  round: number;
  verdict: "pass" | "needs_work";
  findings: Finding[];
  /** ids that were open before this round and are no longer reported */
  closed: string[];
}

/** Lines the CLI prints about itself: the engine banner, tool-call traces and
 * the run trailer. They are not the design. Built with RegExp so the escaping
 * stays readable next to the unicode glyphs the CLIs draw with. */
const TRACE = new RegExp(
  "^(" +
    "\\[engine\\]|\\[agent\\]|\\[exit |" +
    "\\s*[\u25cf\u2713\u2717\u23fa\u2699\u2502\u2514\u251c\u256d\u2570\u2500]|" +
    "\\s*[/\\\\] (Search|Read|Run|Bash)\\b|" +
    "Changes\\s+[+-]|AI Credits\\s|Tokens\\s+[\u2191\u2193]|Resume\\s+\\w" +
    ")",
);

/** The design, lifted out of the raw CLI transcript.
 *
 * `step.output` is everything the process printed: on a real run that was 4,445
 * characters of banner and tool trace before the design even began, plus a
 * 1,173-character trailer after it. Writing that verbatim would hand the next
 * rework its own terminal log to "reproduce exactly". Measured against that
 * run this keeps all 16 REQ blocks and drops 3,548 characters of noise. */
export function designFromOutput(output: string): string {
  const cut = output.indexOf("=== STEP OUTCOME ===");
  const body = cut === -1 ? output : output.slice(0, cut);
  return body
    .split(/\r?\n/)
    .filter((l) => !TRACE.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split a design artifact into the agent's half and the engine's half. */
export function splitArtifact(text: string): { design: string; review: string; log: string } {
  const ri = text.indexOf(`\n${REVIEW_H}`);
  const li = text.indexOf(`\n${LOG_H}`);
  const end = (a: number, b: number) => (a === -1 ? b : b === -1 ? a : Math.min(a, b));
  const designEnd = end(ri, li);
  return {
    design: (designEnd === -1 ? text : text.slice(0, designEnd)).trimEnd(),
    review: ri === -1 ? "" : text.slice(ri, li !== -1 && li > ri ? li : undefined).trim(),
    log: li === -1 ? "" : text.slice(li).trim(),
  };
}

/** Findings already recorded in the artifact, so a re-review can be compared
 * against them and ids can carry over instead of restarting at F1. */
export function openFindings(artifact: string): Finding[] {
  const { review } = splitArtifact(artifact);
  if (!review) return [];
  // findings are rendered as markdown headings ("#### F1 (critical): ...") so
  // the artifact reads well, but parseFindings anchors on the id at line start.
  // Strip the heading marker before parsing - the renderer and the reader have
  // to agree, and readability belongs to the file.
  const flat = review.replace(/^#{1,6}\s+(?=\*{0,2}F\d+[\s:(])/gm, "");
  return parseFindings(flat).findings.filter((f) => !/\bRESOLVED\b/i.test(f.title));
}

function renderReview(rec: ReviewRecord): string {
  const body = rec.findings
    .map((f) => {
      const refs = f.refs.length ? ` [refs: ${f.refs.join(", ")}]` : "";
      return [
        `#### ${f.id} (${f.severity})${refs}: ${f.title}`,
        f.where ? `- Where: ${f.where}` : "",
        f.problem ? `- Problem: ${f.problem}` : "",
        f.fix ? `- Fix: ${f.fix}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  const crit = rec.findings.filter((f) => f.severity === "critical").length;
  return [
    REVIEW_H,
    "",
    `- Verdict: ${rec.verdict}`,
    `- Round: ${rec.round}`,
    `- Open findings: ${rec.findings.length} (${crit} critical)`,
    rec.closed.length ? `- Closed this round: ${rec.closed.join(", ")}` : "",
    "",
    "### Findings",
    "",
    body || "_None._",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Write the design half. Called after the authoring step succeeds; keeps the
 * engine's own sections exactly as they were. */
export async function writeDesign(root: string, rel: string, design: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  let review = "";
  let log = "";
  let previous = "";
  try {
    const raw = await fs.readFile(abs, "utf8");
    const prev = splitArtifact(raw);
    review = prev.review;
    log = prev.log;
    previous = raw;
  } catch {
    /* first pass - nothing to preserve */
  }
  // Keep the version being replaced. The main file is always the CURRENT
  // design; -v1, -v2 ... are the ones it superseded, oldest first, so a
  // rework can be diffed against what it was meant to revise. Without this the
  // revision log records that a round happened but nothing shows what changed.
  if (previous.trim()) {
    const v = await nextVersionPath(abs);
    await fs.writeFile(v, previous, "utf8").catch(() => {});
  }
  const parts = [design.trimEnd(), review, log].filter(Boolean);
  await fs.writeFile(abs, parts.join("\n\n") + "\n", "utf8");
}

/** `…-design.md` -> `…-design-v1.md`, then -v2, and so on. */
async function nextVersionPath(abs: string): Promise<string> {
  const dir = path.dirname(abs);
  const base = path.basename(abs).replace(/\.md$/, "");
  let n = 1;
  for (;;) {
    const p = path.join(dir, `${base}-v${n}.md`);
    const taken = await fs
      .stat(p)
      .then(() => true)
      .catch(() => false);
    if (!taken) return p;
    n++;
  }
}

/** Write the review half and append one revision-log row. The agent's design
 * section is carried through untouched. */
export async function writeReview(root: string, rel: string, rec: ReviewRecord): Promise<void> {
  const abs = path.join(root, rel);
  let design = "";
  let log = "";
  try {
    const prev = splitArtifact(await fs.readFile(abs, "utf8"));
    design = prev.design;
    log = prev.log;
  } catch {
    return; // no artifact means the authoring step never wrote one
  }
  const row = `- Round ${rec.round}: ${rec.verdict}, ${rec.findings.length} open (${
    rec.findings.filter((f) => f.severity === "critical").length
  } critical)${rec.closed.length ? `, closed ${rec.closed.join(", ")}` : ""}`;
  const nextLog = log ? `${log}\n${row}` : `${LOG_H}\n\n${row}`;
  await fs.writeFile(
    abs,
    [design, renderReview(rec), nextLog].filter(Boolean).join("\n\n") + "\n",
    "utf8",
  );
}

/** What the reviewer said about findings it had raised before.
 *
 * Closure used to be inferred from ABSENCE: a finding the reviewer stopped
 * mentioning was recorded closed. That silently overrode the reviewer - on a
 * real round it reported F6 as "partially-addressed" in its own verdict while
 * the engine filed F6 as closed. An explicit status beats an inference, so read
 * the statuses the re-review is asked to give and only fall back to absence for
 * findings it said nothing about at all. */
export function statedOutcomes(reviewOutput: string): {
  resolved: Set<string>;
  partial: Set<string>;
  stillOpen: Set<string>;
} {
  const resolved = new Set<string>();
  const partial = new Set<string>();
  const stillOpen = new Set<string>();
  const pick = (src: string, into: Set<string>) => {
    for (const m of reviewOutput.matchAll(new RegExp(src, "gi"))) into.add(m[1]);
  };
  // both orders appear in practice: "F6: RESOLVED" and "RESOLVED - F6"
  const ID = "(F\\d+)";
  const NEAR = (n: number) => "[^\\n]{0," + n + "}?";
  for (const [word, into] of [
    ["RESOLVED", resolved],
    ["PARTIAL(?:LY)?", partial],
    ["STILL OPEN", stillOpen],
  ] as [string, Set<string>][]) {
    pick(ID + NEAR(40) + word, into);
    pick(word + NEAR(60) + ID, into);
  }
  // a finding cannot be both; the weaker claim wins, because it keeps work open
  for (const id of [...partial, ...stillOpen]) resolved.delete(id);
  for (const id of stillOpen) partial.delete(id);
  return { resolved, partial, stillOpen };
}

/** Did this round move? Used by the engine to stop a loop that is going in
 * circles instead of spending every remaining round on it. On run 029f2a49
 * round 2 to 3 moved criticals 4 to 5 and closed nothing - that is a stall,
 * and three rounds were spent anyway. */
export function madeProgress(prev: ReviewRecord | null, next: ReviewRecord): boolean {
  if (!prev) return true;
  if (next.closed.length > 0) return true;
  const critOf = (r: ReviewRecord) => r.findings.filter((f) => f.severity === "critical").length;
  if (critOf(next) < critOf(prev)) return true;
  return next.findings.length < prev.findings.length;
}
