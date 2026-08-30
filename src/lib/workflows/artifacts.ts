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
 *   the design           the agent writes it (lifted from the step's output)
 *   ## Review            the ENGINE writes it, from the reviewer's stdout
 *   ## Human decisions   the ENGINE writes it, from the gate, append-only
 *   ## Revision log      the ENGINE writes it, append-only
 *
 * The reviewer stays `readOnly` at the CLI - it never gets write access to the
 * document it is judging. */

const REVIEW_H = "## Review";
const DECISIONS_H = "## Human decisions";
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
  // The outcome block is the LAST thing a step writes, and only counts when it
  // opens a line. Cutting at the first mention anywhere truncated a real run:
  // on c10adbb1-2fb the agent quoted the marker at offset 3,172 while
  // describing its own prompt file, and the delta it went on to produce at
  // 48,207 was thrown away with everything else after the quote.
  const marker = /^=== STEP OUTCOME ===/m;
  const hits = [...output.matchAll(new RegExp(marker.source, "gm"))];
  const cut = hits.length ? (hits[hits.length - 1].index ?? -1) : -1;
  const body = cut === -1 ? output : output.slice(0, cut);
  return body
    .split(/\r?\n/)
    .filter((l) => !TRACE.test(l))
    // MANUAL lines are the engine's: `collectManual` harvests them from the
    // same output into the run's human checklist. Left in the body they landed
    // INSIDE the last requirement block - 53 of them on run c10adbb1-2fb - and
    // pushed that block's engine-written STATE line to the bottom of the file,
    // where it read as the state of the MANUAL section instead of a block.
    .filter((l) => !/^\s*\*{0,2}MANUAL:/i.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split a design artifact into the agent's half and the engine's sections.
 *
 * File order is fixed: the design, then `## Review`, `## Human decisions`,
 * `## Revision log`. Each engine section runs to the start of the next one that
 * is present, so a document missing any of them still splits correctly. */
export function splitArtifact(text: string): {
  design: string;
  review: string;
  decisions: string;
  log: string;
} {
  const at = (h: string) => text.indexOf(`\n${h}`);
  const ri = at(REVIEW_H);
  const di = at(DECISIONS_H);
  const li = at(LOG_H);
  const first = (...xs: number[]) => {
    const found = xs.filter((x) => x !== -1);
    return found.length ? Math.min(...found) : -1;
  };
  const slice = (start: number, ...after: number[]) => {
    if (start === -1) return "";
    const end = first(...after.filter((x) => x > start));
    return (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
  };
  const designEnd = first(ri, di, li);
  return {
    design: (designEnd === -1 ? text : text.slice(0, designEnd)).trimEnd(),
    review: slice(ri, di, li),
    decisions: slice(di, ri, li),
    log: slice(li, ri, di),
  };
}

/** Findings already recorded in the artifact, so a re-review can be compared
 * against them and ids can carry over instead of restarting at F1. */
export function openFindings(artifact: string): Finding[] {
  // findings are rendered as markdown headings ("#### F1 (critical): ...") so
  // the artifact reads well, but parseFindings anchors on the id at line start.
  // Strip the heading marker before parsing - the renderer and the reader have
  // to agree, and readability belongs to the file.
  //
  // The WHOLE artifact is scanned, not just the doc-end review section: a
  // finding now lives inside the requirement block it concerns, and one that
  // names three requirements is written into all three. Deduped by id so that
  // filing is not mistaken for three separate findings. A "RESPONSE F24 ..."
  // line cannot be misread as a finding - it neither starts with the id nor
  // carries a severity, so parseFindings passes it over.
  const flat = artifact.replace(/^#{1,6}\s+(?=\*{0,2}F\d+[\s:(])/gm, "");
  const out = new Map<string, Finding>();
  for (const f of parseFindings(flat).findings) {
    if (/\bRESOLVED\b/i.test(f.title)) continue;
    out.set(f.id, f);
  }
  return [...out.values()];
}

/** One finding, rendered for a document rather than a terminal. Shared by the
 * doc-end review section and the per-block lineage so a finding reads the same
 * wherever it lands. */
export function renderFinding(f: Finding): string {
  const refs = f.refs.length ? ` [refs: ${f.refs.join(", ")}]` : "";
  return [
    `#### ${f.id} (${f.severity})${refs}: ${f.title}`,
    f.where ? `- Where: ${f.where}` : "",
    f.problem ? `- Problem: ${f.problem}` : "",
    f.fix ? `- Fix: ${f.fix}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderReview(rec: ReviewRecord): string {
  const body = rec.findings.map(renderFinding).join("\n\n");
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
  let decisions = "";
  let log = "";
  let previous = "";
  try {
    const raw = await fs.readFile(abs, "utf8");
    const prev = splitArtifact(raw);
    review = prev.review;
    decisions = prev.decisions;
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
  const parts = [design.trimEnd(), review, decisions, log].filter(Boolean);
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
  let decisions = "";
  let log = "";
  try {
    const prev = splitArtifact(await fs.readFile(abs, "utf8"));
    design = prev.design;
    decisions = prev.decisions;
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
    [design, renderReview(rec), decisions, nextLog].filter(Boolean).join("\n\n") + "\n",
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

/* ==================================================================== *
 * The living design document
 *
 * Run 1e3dc542-bbc: the design step's glob does not traverse dot-dirs, so
 * round 4 concluded no prior design existed and authored a fresh one -
 * silently discarding three rounds of accepted fixes (104 KB -> 69 KB,
 * every closed finding reopened, `## Review` left describing a document
 * that no longer existed).
 *
 * The glob is not the root cause. The root cause is that the designer
 * RE-TYPES the entire document every round, so one bad round can replace
 * all of it - and output grew 44k -> 53k -> 60k tokens reproducing blocks
 * nobody asked it to touch.
 *
 * So after the first authoring pass the designer sends a DELTA - only the
 * blocks it changed - and the engine splices it in. Untouched blocks are
 * carried through byte-for-byte and cannot be lost by a bad generation.
 *
 * Findings, and the designer's response to each, are appended INSIDE the
 * block they concern. Previously findings lived in one doc-end `## Review`
 * that `writeReview` OVERWROTE every round: design-v2.md's review section
 * holds F23-F32 and F1-F22 are simply gone, so by round 3 nobody could see
 * why an earlier decision was made.
 *
 * Ownership inside a block:
 *   above the lineage mark   the agent's design fields - replaceable
 *   below the lineage mark   the engine's history - append-only
 * ==================================================================== */

/** Separates the agent's half of a block from the engine's. An HTML comment
 * so it is invisible in rendered markdown, and deliberately NOT a box-drawing
 * character - `TRACE` above strips lines starting with those, so a lineage
 * header drawn with them would be deleted the moment the text passed through
 * `designFromOutput`. */
export const LINEAGE_MARK = "<!-- lineage -->";
export const DELTA_START = "=== DELTA START ===";
export const DELTA_END = "=== DELTA END ===";
export const DESIGN_START = "=== DESIGN START ===";
export const DESIGN_END = "=== DESIGN END ===";

/** The last complete `start`..`end` pair, or "" when there is none.
 *
 * The LAST pair, never the first open to the last close: a CLI that restarts
 * mid-answer emits the fence twice, and spanning both merges a truncated
 * attempt with the good one. */
function fenced(text: string, start: string, end: string): string {
  const e = text.lastIndexOf(end);
  if (e !== -1) {
    const s = text.lastIndexOf(start, e);
    if (s !== -1 && e > s) return text.slice(s + start.length, e);
  }
  // An OPEN fence still carries the answer. A step that ran out of budget mid
  // sentence closes nothing, and on run c10adbb1-2fb the final round's whole
  // delta was discarded for want of a closing line. Take what there is; the
  // block parser keeps only the blocks that completed.
  const s = text.lastIndexOf(start);
  return s === -1 ? "" : text.slice(s + start.length);
}

/** Anchored the same way `parseRequirements` anchors the UI cards, so the
 * document the engine splices and the document the gate renders can never
 * disagree about where a block begins. */
// The colon is optional on the way IN. An authoring pass wrote its drafts as
// "### REQ-018 Search invoices" and its final blocks as "### REQ-018: Search
// invoices"; requiring the colon meant 34 drafts were not seen as blocks at
// all, so they were swept into the preamble as 61 KB of invisible junk instead
// of being recognised as duplicates and collapsed. The RENDERER emits a
// canonical "### REQ-018: Title", so what we write is always the strict form.
const BLOCK_HEAD = "^###[ \\t]+(REQ-\\d+)\\b[^\\n]*$";
const RESPONSE_HEAD = /^RESPONSE\s+F\d+\b/;
const FIELD_HEAD = /^[A-Z][A-Z0-9 _-]{0,30}:/;

/** A field body that points at text it does not contain.
 *
 * "Only the fields you are changing" was read as "a diff of the prose inside
 * the field", so a revision wrote `DESIGN: (unchanged core algorithm) with step
 * 8 corrected: ...` and `DESIGN: Create X as previously designed`. Merging
 * replaces a field whole, so those references REPLACED the design: on run
 * 9d512b43-a36, 21 of 34 blocks lost their substance, including the 17-day
 * allocation engine. The reviewer's verdict was the right one - "I cannot check
 * what I cannot read" - and a build agent could not have built it either. */
const BACK_REFERENCE =
  /\bas previously (designed|cited|described|stated|specified|written|noted)\b|\(unchanged\b|\bas above\b|\bper the earlier\b|\bsee (the )?(earlier|previous|prior|current) (document|design|version|block|text)\b|\bno change from\b|\bunchanged from (the )?(previous|prior|earlier)\b/i;

/** A field whose VALUE opens with a gesture is a placeholder, whatever words it
 * chose. "STATUS/EVIDENCE: unchanged, see current document." matched no fixed
 * phrase; both it and "`getContext` as previously cited" appeared in a real
 * revision and would have replaced a real field with a pointer.
 *
 * Position is the discriminator, not length. A placeholder LEADS with the
 * gesture; prose does not - "the balance is unchanged by a reversal, which is
 * the point" is a design decision that happens to use the word, and refusing it
 * would throw away a real change. */
const OPENS_WITH_GESTURE = /^(unchanged|same as before|no change|as before|not changed)\b/i;

/** Fields in a delta whose body defers to text that is not in it. */
export function deferringFields(design: string): string[] {
  const out: string[] = [];
  let label = "";
  let body = "";
  const flush = () => {
    if (!label) return;
    const value = body.slice(body.indexOf(":") + 1).trim();
    if (BACK_REFERENCE.test(body) || OPENS_WITH_GESTURE.test(value)) out.push(label);
  };
  for (const line of design.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9 _-]{0,30}):/);
    if (m) {
      flush();
      label = m[1];
      body = line;
    } else if (label) body += `\n${line}`;
  }
  flush();
  return [...new Set(out)];
}

/** Where a requirement stands. Only a human gate may set `approved`; a review
 * that objects to an approved block moves it to `approved-objected` rather
 * than reopening it, because an approval is the human's to withdraw. */
export type BlockState = "open" | "clean" | "approved" | "approved-objected" | "parked";

const STATE_TEXT: Record<BlockState, string> = {
  open: "open",
  clean: "clean",
  approved: "approved",
  "approved-objected": "approved - reviewer objects",
  parked: "parked - awaiting a decision",
};

const STATE_OF: Record<string, BlockState> = {
  open: "open",
  clean: "clean",
  approved: "approved",
  "approved - reviewer objects": "approved-objected",
  "parked - awaiting a decision": "parked",
};

export interface DesignBlock {
  id: string;
  heading: string;
  /** the agent's design fields: everything above the lineage mark */
  design: string;
  /** the engine's append-only history: everything below it */
  lineage: string;
  /** the block exactly as it was read, so an untouched block is re-emitted
   * byte-for-byte instead of being normalised on its way through */
  raw: string;
  /** set when something in this block changed and `raw` is stale */
  dirty?: boolean;
}

export interface ParsedDesign {
  /** title + OVERVIEW: everything before the first REQ block */
  preamble: string;
  blocks: DesignBlock[];
}

/** Split a design into its preamble and its requirement blocks. */
export function parseBlocks(text: string): ParsedDesign {
  const marks: { id: string; start: number; headEnd: number; heading: string }[] = [];
  for (const m of text.matchAll(new RegExp(BLOCK_HEAD, "gm"))) {
    marks.push({
      id: m[1],
      start: m.index ?? 0,
      headEnd: (m.index ?? 0) + m[0].length,
      heading: m[0],
    });
  }
  if (marks.length === 0) return { preamble: text.trimEnd(), blocks: [] };
  const blocks = marks.map((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const body = text.slice(mk.headEnd, end);
    const li = body.indexOf(LINEAGE_MARK);
    return {
      id: mk.id,
      heading: mk.heading,
      design: (li === -1 ? body : body.slice(0, li)).trim(),
      lineage: li === -1 ? "" : body.slice(li + LINEAGE_MARK.length).trim(),
      raw: text.slice(mk.start, end).trimEnd(),
    };
  });
  // A requirement may appear only once. When a pass emits the same id twice -
  // an earlier draft and the final block - keeping both leaves the document
  // self-contradictory, and every later round is spent reporting the
  // contradiction: 52 headings for 34 ids on run c10adbb1-2fb, flagged as
  // F17/F39/F54 across four rounds. The LAST copy wins, because that is the
  // one the agent finished with.
  const byId = new Map<string, DesignBlock>();
  for (const b of blocks) byId.set(b.id, b);
  return { preamble: text.slice(0, marks[0].start).trimEnd(), blocks: [...byId.values()] };
}

/** Requirement ids a text declares more than once. */
export function duplicateBlocks(text: string): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const m of text.matchAll(new RegExp(BLOCK_HEAD, "gm"))) {
    if (seen.has(m[1])) dupes.add(m[1]);
    seen.add(m[1]);
  }
  return [...dupes];
}

/** Rebuild a design. A block nothing touched is emitted from `raw`, so a
 * round that changes three blocks cannot reformat the other thirty-one. */
export function renderBlocks(parsed: ParsedDesign): string {
  const parts = parsed.blocks.map((b) =>
    b.dirty
      ? [b.heading, "", b.design, b.lineage ? `\n${LINEAGE_MARK}\n\n${b.lineage}` : ""]
          .filter((s) => s !== "")
          .join("\n")
          .trimEnd()
      : b.raw,
  );
  return [parsed.preamble, ...parts].filter((s) => s.trim() !== "").join("\n\n") + "\n";
}

export function blockIds(text: string): string[] {
  return parseBlocks(text).blocks.map((b) => b.id);
}

/** Requirement blocks that existed before a write and would not survive it.
 *
 * The guard that would have caught run 1e3dc542-bbc: a "revision" that drops
 * requirement ids is not a revision, and is refused rather than written. */
export function droppedBlocks(before: string, after: string): string[] {
  const now = new Set(blockIds(after));
  return blockIds(before).filter((id) => !now.has(id));
}

export interface DeltaBlock {
  id: string;
  heading: string;
  /** design fields only - the lines above the first RESPONSE */
  design: string;
  /** the designer's answers to findings - the first RESPONSE line onward */
  responses: string;
}

export interface Delta {
  /** `full` = first authoring pass, the whole document. `delta` = changed
   * blocks only. `none` = the agent emitted neither, which is a failure the
   * caller must refuse rather than paper over. */
  mode: "full" | "delta" | "none";
  /** the whole design, for `full` */
  body: string;
  blocks: DeltaBlock[];
  /** ids the agent declared untouched; advisory, never trusted for writing */
  unchanged: string[];
}

/** Read what the designer produced.
 *
 * A fenced DELTA is a revision. No fence is the first authoring pass - and,
 * when a design already exists, is exactly the round-4 failure, so the caller
 * is told `full` and decides (it refuses when a document is already on disk).
 * Everything outside the fence is ignored, which is what makes a mid-generation
 * retry or a burst of narration unable to corrupt the document. */
export function extractDelta(text: string): Delta {
  const inner = fenced(text, DELTA_START, DELTA_END);
  if (!inner) {
    // An authoring pass. Its fence matters as much as the delta's: an unfenced
    // D1 on run c10adbb1-2fb wrote 86 requirement headings for 34 ids, because
    // the agent drafted blocks out of order while investigating and then wrote
    // the real design underneath - and the whole transcript became the file.
    // The very next round, fenced, emitted 14 headings and only the 7 inside
    // the fence were kept, every one unique.
    const design = fenced(text, DESIGN_START, DESIGN_END).trim();
    const body = design || text.trim();
    return { mode: body ? "full" : "none", body, blocks: [], unchanged: [] };
  }
  const unchanged = [
    ...new Set(
      (inner.match(/^UNCHANGED:[^\n]*/m)?.[0] ?? "").match(/REQ-\d+/g) ?? [],
    ),
  ];
  const blocks = parseBlocks(inner).blocks.map((b) => {
    // Classified line by line, not split at the first RESPONSE.
    //
    // Splitting by POSITION meant a design field written after a response line
    // was swallowed into the response text and filed as history instead of
    // being merged as a field - so the edit was silently lost. On run
    // 9d512b43-a36 that happened to REQ-023 and REQ-024's DEPENDS-ON, and the
    // reviewer reported it as a document defect (F36) rather than as the lost
    // design change it was. Order is the agent's business; structure is ours.
    const design: string[] = [];
    const responses: string[] = [];
    let into = design;
    for (const line of b.design.split(/\r?\n/)) {
      if (RESPONSE_HEAD.test(line)) into = responses;
      else if (FIELD_HEAD.test(line)) into = design;
      into.push(line);
    }
    return {
      id: b.id,
      heading: b.heading,
      design: design.join("\n").trim(),
      responses: responses.join("\n").trim(),
    };
  });
  return { mode: "delta", body: "", blocks, unchanged };
}

/** A labelled field line: `BRD-REF:`, `STATUS:`, `DESIGN:`, `EFFORT:` and the
 * rest. Matched by shape rather than a fixed list, so a UX block's own labels
 * and any field added later merge the same way without a code change. */
const FIELD_LINE = /^([A-Z][A-Z0-9 _-]{0,30}):/;

function splitFields(design: string): { lead: string; fields: { label: string; body: string }[] } {
  const fields: { label: string; body: string }[] = [];
  const lead: string[] = [];
  let cur: { label: string; body: string } | null = null;
  for (const line of design.split(/\r?\n/)) {
    const m = line.match(FIELD_LINE);
    if (m) {
      cur = { label: m[1], body: line };
      fields.push(cur);
    } else if (cur) {
      cur.body += `\n${line}`;
    } else {
      lead.push(line);
    }
  }
  return { lead: lead.join("\n").trim(), fields };
}

/** Overlay a delta's fields onto a block's existing fields.
 *
 * A delta says "only the fields you are changing", and the first version of
 * this took it as "the block's new design", swapping the whole half. On the
 * first live run the designer sent DESIGN and EFFORT for a revised block - as
 * asked - and BRD-REF, STATUS and EVIDENCE were deleted with it: 34 blocks had
 * all three after the authoring pass, and five, five and nine had them three
 * rounds later.
 *
 * So a field the delta does not mention is kept, a field it does mention is
 * replaced whole (multi-line bodies included), and a field it introduces is
 * appended. Nothing in a block can be lost by not being mentioned. */
export function mergeFields(existing: string, incoming: string): string {
  const from = splitFields(incoming);
  if (from.fields.length === 0) return incoming.trim() || existing;
  const to = splitFields(existing);
  const next = new Map(from.fields.map((f) => [f.label, f.body]));
  const used = new Set<string>();
  const merged = to.fields.map((f) => {
    if (!next.has(f.label)) return f.body;
    used.add(f.label);
    return next.get(f.label)!;
  });
  for (const f of from.fields) if (!used.has(f.label)) merged.push(f.body);
  return [from.lead || to.lead, ...merged].filter((s) => s.trim() !== "").join("\n").trim();
}

export interface ApplyResult {
  text: string;
  /** ids whose design and/or responses were merged in */
  applied: string[];
  /** ids the delta named that the document does not have - never invented,
   * because a designer inventing a requirement id is a fact the human needs
   * to see rather than a block to silently append */
  unknown: string[];
}

/** Merge a delta into the current design.
 *
 * A delta block with design fields replaces that block's design. A delta block
 * carrying only RESPONSE lines - the shape used for a block the human approved
 * and the reviewer later objected to - leaves the design untouched and records
 * the answer only. Either way the responses are appended to the block's own
 * history, under the round that produced them. */
export function applyDelta(design: string, delta: Delta, round: number): ApplyResult {
  const parsed = parseBlocks(design);
  const byId = new Map(parsed.blocks.map((b) => [b.id, b]));
  const applied: string[] = [];
  const unknown: string[] = [];
  for (const d of delta.blocks) {
    const block = byId.get(d.id);
    if (!block) {
      unknown.push(d.id);
      continue;
    }
    if (d.design) {
      block.design = mergeFields(block.design, d.design);
      block.dirty = true;
    }
    if (d.responses) {
      block.lineage = [block.lineage, `##### D${round} designer`, "", d.responses]
        .filter((s) => s !== "")
        .join("\n\n")
        .trim();
      block.dirty = true;
    }
    if (d.design || d.responses) applied.push(d.id);
  }
  return { text: renderBlocks(parsed), applied, unknown };
}

export interface PlaceResult {
  text: string;
  /** findings whose refs match no block in this document; they belong to the
   * design as a whole and are surfaced separately rather than dropped */
  unassigned: Finding[];
}

/** File each finding under every requirement it references.
 *
 * A finding that names three requirements is written into all three: on run
 * 1e3dc542-bbc, F37 referenced REQ-013, REQ-022 and REQ-024 because a change
 * inside one invalidated an assumption in another - and that is precisely the
 * reader who needs to see it. */
export function placeFindings(design: string, rec: ReviewRecord): PlaceResult {
  const parsed = parseBlocks(design);
  const byId = new Map(parsed.blocks.map((b) => [b.id, b]));
  const header = `##### R${rec.round} reviewer`;
  const unassigned: Finding[] = [];
  for (const f of rec.findings) {
    const targets = f.refs.filter((r) => byId.has(r));
    if (targets.length === 0) {
      unassigned.push(f);
      continue;
    }
    for (const id of targets) {
      const block = byId.get(id)!;
      const body = renderFinding(f);
      block.lineage = block.lineage.includes(header)
        ? `${block.lineage}\n\n${body}`
        : [block.lineage, header, "", body].filter((s) => s !== "").join("\n\n").trim();
      block.dirty = true;
    }
  }
  return { text: renderBlocks(parsed), unassigned };
}

/** Stamp each block's STATE line. The engine owns this: it is derived from the
 * findings and the human's gate decisions, never asserted by an agent. */
export function setBlockStates(design: string, states: Record<string, BlockState>): string {
  const parsed = parseBlocks(design);
  for (const block of parsed.blocks) {
    const next = states[block.id];
    if (!next) continue;
    const line = `STATE: ${STATE_TEXT[next]}`;
    const lines = block.design.split(/\r?\n/);
    const at = lines.findIndex((l) => /^STATE:/.test(l));
    if (at === -1) lines.push(line);
    else if (lines[at] === line) continue;
    else lines[at] = line;
    block.design = lines.join("\n").trim();
    block.dirty = true;
  }
  return renderBlocks(parsed);
}

/** Read back the states the engine stamped, so a later round can tell an
 * approval it must not touch from a block it is free to rework. */
export function blockStates(design: string): Record<string, BlockState> {
  const out: Record<string, BlockState> = {};
  for (const b of parseBlocks(design).blocks) {
    const raw = b.design.match(/^STATE:\s*(.+)$/m)?.[1]?.trim().toLowerCase();
    out[b.id] = (raw && STATE_OF[raw]) || "open";
  }
  return out;
}

export interface MergeResult {
  text: string;
  /** blocks the incoming body omitted, kept anyway */
  kept: string[];
  /** blocks the incoming body introduced */
  added: string[];
}

/** Merge a WHOLE re-emitted design over the one on disk.
 *
 * The safety net for the round-4 failure. That round re-authored from scratch
 * and its body carried the same 34 requirement ids, so an id-count guard would
 * have waved it through - what it actually destroyed was the accumulated
 * history and the fixes inside the blocks.
 *
 * So a full body may replace design FIELDS but can never take a block's
 * lineage with it, and a block it forgot is kept rather than dropped. A round
 * that loses its memory now loses only its own prose; every finding, every
 * response and every requirement survives, and the caller is told what it
 * failed to re-emit. */
export function mergeFull(existing: string, incoming: string): MergeResult {
  const prev = parseBlocks(existing);
  if (prev.blocks.length === 0) return { text: incoming, kept: [], added: [] };
  const next = parseBlocks(incoming);
  const incomingById = new Map(next.blocks.map((b) => [b.id, b]));
  const seen = new Set<string>();
  const kept: string[] = [];
  const blocks: DesignBlock[] = [];
  for (const old of prev.blocks) {
    const fresh = incomingById.get(old.id);
    seen.add(old.id);
    if (!fresh) {
      kept.push(old.id);
      blocks.push(old);
      continue;
    }
    blocks.push({
      ...old,
      heading: fresh.heading,
      design: mergeFields(old.design, fresh.design),
      dirty: true,
    });
  }
  const added = next.blocks.filter((b) => !seen.has(b.id)).map((b) => b.id);
  for (const b of next.blocks) if (!seen.has(b.id)) blocks.push({ ...b, dirty: true });
  return {
    text: renderBlocks({ preamble: next.preamble || prev.preamble, blocks }),
    kept,
    added,
  };
}

/** What each block's state becomes after a review round.
 *
 * An approval is the human's to withdraw, so a reviewer objecting to an
 * approved block moves it to `approved-objected` - visible at the next gate -
 * rather than reopening it for the designer to quietly rework. */
export function statesAfterReview(design: string, rec: ReviewRecord): Record<string, BlockState> {
  const prev = blockStates(design);
  const flagged = new Set(rec.findings.flatMap((f) => f.refs));
  const out: Record<string, BlockState> = {};
  for (const id of Object.keys(prev)) {
    const wasApproved = prev[id] === "approved" || prev[id] === "approved-objected";
    out[id] = wasApproved
      ? flagged.has(id)
        ? "approved-objected"
        : "approved"
      : flagged.has(id)
        ? "open"
        : "clean";
  }
  return out;
}

export interface DesignWrite {
  /** `authored` first pass · `delta` spliced · `merged` a whole body folded in
   * over the existing one · `refused` nothing was written */
  mode: "authored" | "delta" | "merged" | "refused";
  applied: string[];
  unknown: string[];
  kept: string[];
  added: string[];
  dropped: string[];
  /** one line for the step trace, so the run says what the engine did */
  note: string;
}

/** The design write path.
 *
 * Every route through here is non-destructive by construction: a delta touches
 * only the blocks it names, a whole body may replace design fields but never
 * lineage, and a write that would still lose a requirement is refused outright
 * rather than persisted. The document on disk can only grow.  */
export async function writeDesignUpdate(
  root: string,
  rel: string,
  produced: string,
  round: number,
): Promise<DesignWrite> {
  const abs = path.join(root, rel);
  const none: DesignWrite = {
    mode: "refused",
    applied: [],
    unknown: [],
    kept: [],
    added: [],
    dropped: [],
    note: "",
  };
  const delta = extractDelta(produced);
  if (delta.mode === "none") {
    return { ...none, note: `${rel} left as it was - the step produced no design` };
  }
  let existing = "";
  try {
    existing = await fs.readFile(abs, "utf8");
  } catch {
    /* first pass */
  }
  if (!existing.trim()) {
    if (delta.mode === "delta") {
      return {
        ...none,
        note: `${rel} not written - the step sent a DELTA but no design exists yet to apply it to`,
      };
    }
    await writeDesign(root, rel, delta.body);
    return { ...none, mode: "authored", note: `${rel} authored` };
  }
  const prev = splitArtifact(existing);
  let design: string;
  const out: DesignWrite = { ...none };
  if (delta.mode === "delta") {
    const r = applyDelta(prev.design, delta, round);
    design = r.text;
    out.mode = "delta";
    out.applied = r.applied;
    out.unknown = r.unknown;
    out.note = `${rel}: ${r.applied.length} block(s) revised${
      r.unknown.length ? `; unknown id(s) ignored: ${r.unknown.join(", ")}` : ""
    }`;
  } else {
    const m = mergeFull(prev.design, delta.body);
    design = m.text;
    out.mode = "merged";
    out.kept = m.kept;
    out.added = m.added;
    out.note =
      `${rel}: a whole design was re-sent instead of a delta - field text taken, ` +
      `all review history kept` +
      (m.kept.length ? `; ${m.kept.length} block(s) it omitted were preserved: ${m.kept.join(", ")}` : "") +
      (m.added.length ? `; new block(s): ${m.added.join(", ")}` : "");
  }
  const dropped = droppedBlocks(prev.design, design);
  if (dropped.length > 0) {
    return {
      ...none,
      dropped,
      note: `${rel} NOT written - the revision would have dropped ${dropped.join(", ")}`,
    };
  }
  const v = await nextVersionPath(abs);
  await fs.writeFile(v, existing, "utf8").catch(() => {});
  await fs.writeFile(
    abs,
    [design.trimEnd(), prev.review, prev.decisions, prev.log].filter(Boolean).join("\n\n") + "\n",
    "utf8",
  );
  return out;
}

/** Record what the human decided at a gate.
 *
 * The decision used to exist only in `run.revisions`: injected into the
 * designer's next prompt and then invisible - not in the document, not in the
 * UI, and never shown to the reviewer, which was free to re-raise the very
 * thing the human had just ruled on.
 *
 * It is written by the ENGINE, in the human's own words, append-only. An agent
 * paraphrasing the instruction it was given is not a record of the instruction.
 * Blocks the human approved are stamped `approved` here too, which is the only
 * way that state is ever set. */
export async function recordHumanDecision(
  root: string,
  rel: string,
  entry: { action: "approved" | "revise"; text: string; approvedIds?: string[] },
): Promise<boolean> {
  const abs = path.join(root, rel);
  let raw = "";
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    return false;
  }
  const prev = splitArtifact(raw);
  const n = (prev.decisions.match(/^### Gate \d+/gm)?.length ?? 0) + 1;
  const body = [
    `### Gate ${n} - ${entry.action === "approved" ? "approved" : "revision requested"}`,
    "",
    entry.text.trim() || "_No instruction given._",
  ].join("\n");
  const decisions = prev.decisions ? `${prev.decisions}\n\n${body}` : `${DECISIONS_H}\n\n${body}`;
  const design = entry.approvedIds?.length
    ? setBlockStates(
        prev.design,
        Object.fromEntries(entry.approvedIds.map((id) => [id, "approved" as BlockState])),
      )
    : prev.design;
  await fs.writeFile(
    abs,
    [design.trimEnd(), prev.review, decisions, prev.log].filter(Boolean).join("\n\n") + "\n",
    "utf8",
  );
  return true;
}

/** Fold one review round into the document.
 *
 * Findings land inside the requirement blocks they name. Anything that names
 * no block in this document - a finding about the design as a whole - goes to
 * `## Review`, which is now APPENDED to per round instead of replaced: the old
 * behaviour is why design-v2.md's review section holds F23-F32 and F1-F22 are
 * simply gone.
 *
 * A document with no requirement blocks (the UX design, whose blocks are UX-n)
 * keeps the previous behaviour exactly. */
export async function recordReview(
  root: string,
  rel: string,
  rec: ReviewRecord,
): Promise<Finding[] | null> {
  const abs = path.join(root, rel);
  let raw = "";
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    return null; // no artifact means the authoring step never wrote one
  }
  const prev = splitArtifact(raw);
  if (parseBlocks(prev.design).blocks.length === 0) {
    await writeReview(root, rel, rec);
    return rec.findings;
  }
  const placed = placeFindings(prev.design, rec);
  const design = setBlockStates(placed.text, statesAfterReview(prev.design, rec));
  const crit = rec.findings.filter((f) => f.severity === "critical").length;
  const round = [
    `### Round ${rec.round} - ${rec.verdict}, ${rec.findings.length} open (${crit} critical)`,
    rec.closed.length ? `\nClosed this round: ${rec.closed.join(", ")}` : "",
    placed.unassigned.length
      ? `\n${placed.unassigned.map(renderFinding).join("\n\n")}`
      : "\n_Every finding is filed under its requirement._",
  ]
    .filter(Boolean)
    .join("\n");
  const review = prev.review ? `${prev.review}\n\n${round}` : `${REVIEW_H}\n\n${round}`;
  const row = `- Round ${rec.round}: ${rec.verdict}, ${rec.findings.length} open (${crit} critical)${
    rec.closed.length ? `, closed ${rec.closed.join(", ")}` : ""
  }`;
  const log = prev.log ? `${prev.log}\n${row}` : `${LOG_H}\n\n${row}`;
  await fs.writeFile(
    abs,
    [design.trimEnd(), review, prev.decisions, log].filter(Boolean).join("\n\n") + "\n",
    "utf8",
  );
  return placed.unassigned;
}
