import path from "node:path";
import { promises as fs } from "node:fs";
import { type Finding } from "@/lib/findings";
import {
  deferringFields,
  LINEAGE_MARK,
  mergeFields,
  parseBlocks,
  renderFinding,
  type BlockState,
  type Delta,
  type ReviewRecord,
} from "./artifacts";

/** The design, as STATE rather than as prose.
 *
 * Every defect this file exists to prevent had one shape: the engine kept its
 * bookkeeping inside a human-readable document, so it had to read that document
 * back and recover its own data with regexes. Measured on real runs:
 *
 *   - the engine renders a finding as "#### F73 (nit): ...", the reviewer reads
 *     the document every round, copies the heading style into its own answer,
 *     and `parseFindings` - which anchors the id at line start - goes blind. The
 *     step failed its own output contract and killed a 2h51m run one step
 *     before the human gate. (c10adbb1-2fb, round 8)
 *   - open findings were re-derived by reading the document back, so once
 *     findings were filed inline and KEPT, every finding ever raised read as
 *     "open before this round" and was reported closed again: round 3 closed 28
 *     of the 33 that existed, round 7 closed 39. `madeProgress` treats any
 *     closure as progress, so the loop could not stall and ran eight rounds.
 *   - an authoring pass wrote 86 requirement headings for 34 requirements,
 *     because its scratch drafts and its final design were both prose in the
 *     same stream.
 *
 * So the state lives here, in a structure, and the markdown is RENDERED from
 * it. The engine writes `design.md`; it never reads it. A model cannot teach
 * the engine a format it cannot parse, because nothing parses the rendering.
 *
 * The agent's stdout is still prose - that is what a CLI gives us - but it is
 * parsed exactly once, at the boundary, into this shape. */

export const DOC_VERSION = 1;

export interface DesignField {
  label: string;
  /** the whole field including its label line, multi-line bodies intact */
  body: string;
}

export interface LineageEntry {
  round: number;
  kind: "review" | "designer";
  body: string;
}

/** Where a finding stands. Deliberately NOT the same words a block uses: only a
 * human approves a BLOCK, and a finding being dealt with is a different fact
 * from a requirement being signed off. Keeping the two vocabularies apart is
 * what stops the gate meaning two things at once. */
export type FindingStatus = "open" | "resolved" | "rejected" | "waived";

export interface FindingEntry {
  id: string;
  severity: Finding["severity"];
  /** every requirement it concerns - the finding is stored ONCE, here */
  refs: string[];
  title: string;
  where: string;
  problem: string;
  fix: string;
  status: FindingStatus;
  /** Can the DESIGN close this, or does it need an answer from outside?
   *
   * The loop used to chase zero, and zero is not always reachable: on run
   * d0e4f7bc-1d6 five findings were still open at the last round because their
   * fixes were "confirm with Portal 1 what shape the invoice lines are" and
   * "define the percentage base, or scope it out". No amount of redesigning
   * produces information nobody has. Those are decisions for a human, and the
   * loop should hand them over rather than spend rounds failing to design
   * around them. */
  needs: "fix" | "decide";
  /** for `decide`: the question, and who must answer it */
  question?: string;
  raisedRound: number;
  closedRound?: number;
  /** why it is not open any more, in the words of whoever closed it */
  note?: string;
}

/** "NEEDS: decide - Portal 1 must confirm the invoice line shape" */
const NEEDS_LINE = /^\s*NEEDS:\s*(fix|decide)\b[\s-]*(.*)$/im;

/** Read the reviewer's classification out of one finding's text. Defaults to
 * `fix`, because treating a fixable defect as a decision would ship it as a
 * question when it should have been solved. */
export function classifyFinding(body: string): { needs: "fix" | "decide"; question?: string } {
  const m = body.match(NEEDS_LINE);
  if (!m || m[1].toLowerCase() === "fix") return { needs: "fix" };
  return { needs: "decide", question: m[2].trim() || undefined };
}

export interface DesignBlockDoc {
  id: string;
  /** the title alone; the heading is rendered canonically from id + title */
  title: string;
  /** kept for documents written before titles were stored separately */
  heading?: string;
  fields: DesignField[];
  /** DERIVED from the finding register - never set by a round in isolation */
  state: BlockState;
  /** one short line per round: what happened to this block and why */
  history: { round: number; note: string }[];
  /** The design AS IT STOOD at each round: D1 as authored, then one entry per
   * revision, with the findings that drove it. Kept in state and rendered into
   * `design-history.md` - never into `design.md`, which goes to both agents on
   * every round and is already 144 KB. What a reader wants ("what did we
   * design, why did it change, which version was signed off") and what an agent
   * needs to work ("the current design") are different documents. */
  revisions: { round: number; drivenBy: string[]; fields: DesignField[] }[];
  lineage?: LineageEntry[];
}

export interface DesignDoc {
  version: number;
  /** title + OVERVIEW: everything before the first requirement */
  preamble: string;
  blocks: DesignBlockDoc[];
  /** Every finding ever raised, ONCE, with its status.
   *
   * Findings used to be copied into each requirement they named: 35 findings
   * became 106 copies on run 9d512b43-a36 - one filed into 17 blocks - and
   * 126 KB of a 216 KB document was duplicated review text, re-sent to both
   * agents every round. A finding is not a property of a block; it is its own
   * thing, with its own life. */
  findings: FindingEntry[];
  /** findings that named no requirement in this document, by round */
  unassigned: { round: number; findings: Finding[] }[];
  decisions: { gate: number; action: "approved" | "revise"; text: string }[];
  log: string[];
  /** legacy: superseded by `findings`, kept so an older run still loads */
  openFindings: string[];
}

const STATE_TEXT: Record<BlockState, string> = {
  open: "open",
  clean: "clean",
  approved: "approved",
  "approved-objected": "approved - reviewer objects",
  parked: "parked - awaiting a decision",
};

const FIELD_LINE = /^([A-Z][A-Z0-9 _-]{0,30}):/;
/** Engine-owned fields: written by us on every render, so they are stripped on
 * the way IN. Without this a document that is read back and re-rendered grows a
 * second copy of each of them. */
const OWNED = new Set(["STATE", "OPEN FINDINGS", "HISTORY"]);

function toFields(design: string): DesignField[] {
  const out: DesignField[] = [];
  let cur: DesignField | null = null;
  for (const line of design.split(/\r?\n/)) {
    const m = line.match(FIELD_LINE);
    if (m) {
      cur = { label: m[1], body: line };
      out.push(cur);
    } else if (cur) {
      cur.body += `\n${line}`;
    } else if (line.trim()) {
      // free text before any label - keep it as an unlabelled leading field so
      // nothing an agent wrote is silently dropped
      cur = { label: "", body: line };
      out.push(cur);
    }
  }
  return out.filter((f) => !OWNED.has(f.label));
}

/** The title out of whatever heading form the agent used: with a colon, with a
 * dash, or with neither. The renderer then emits one canonical form. */
function titleOf(heading: string, id: string): string {
  return heading
    .replace(/^#{1,6}[ \t]+/, "")
    .replace(new RegExp(`^${id}\\b`), "")
    .replace(/^[\s:\u2013\u2014-]+/, "")
    .trim();
}

function fieldsToText(fields: DesignField[]): string {
  return fields
    .map((f) => f.body)
    .join("\n")
    .trim();
}

/** Everything before the first requirement is supposed to be the OVERVIEW. In
 * practice a step investigates out loud first: on run a9f88c51-fa2 the design
 * pass explored five areas in parallel and wrote 472 lines of notes - objects,
 * Apex classes, LWCs, permission sets - and only then wrote `# OVERVIEW` and
 * the real design. All 60 KB became the document's opening, and would have
 * been re-sent to the designer and the reviewer on every one of ten rounds.
 *
 * The output format already names the anchor, and a model writes it reliably
 * because it is asked for: keep from the LAST OVERVIEW heading. Notes above it
 * are working-out, not the design. Nothing found, nothing trimmed. */
function trimToOverview(preamble: string): string {
  const hits = [...preamble.matchAll(/^#{1,3}[ \t]*OVERVIEW\b[^\n]*$/gim)];
  if (hits.length === 0) return preamble;
  return preamble.slice(hits[hits.length - 1].index ?? 0).trim();
}

/** Build a document from the agent's authored markdown. Used for the first
 * authoring pass, and once per run to adopt a design written before this
 * structure existed. */
export function fromMarkdown(md: string): DesignDoc {
  const parsed = parseBlocks(md);
  return {
    version: DOC_VERSION,
    preamble: trimToOverview(parsed.preamble),
    blocks: parsed.blocks.map((b) => ({
      id: b.id,
      title: titleOf(b.heading, b.id),
      fields: toFields(b.design),
      state: "open" as BlockState,
      history: [],
      revisions: [{ round: 1, drivenBy: [], fields: toFields(b.design) }],
      lineage: b.lineage ? [{ round: 0, kind: "review" as const, body: b.lineage }] : [],
    })),
    findings: [],
    unassigned: [],
    decisions: [],
    log: [],
    openFindings: [],
  };
}

/** Quote a line inside a finding or a response that would otherwise read as
 * document structure.
 *
 * A reviewer quotes the design it is judging, so its findings carry lines like
 * `### REQ-020: ...` and `MANUAL: ...`. Rendered as-is they become real
 * headings: the replayed run produced 68 requirement headings for 34
 * requirements, and the gate builds its cards by scanning for exactly that
 * pattern - so a quotation inside a finding would have appeared to the human as
 * a second copy of the requirement. Marked as the quotation it is. */
function quoteStructure(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => (/^\s*(#{1,6}\s*REQ-\d+|MANUAL:)/i.test(l) ? `> ${l.trim()}` : l))
    .join("\n");
}

/** One canonical heading, whatever the agent wrote. The UI parses the rendered
 * document for its gate cards with a stricter pattern than we accept on input,
 * so the renderer is where the two are made to agree. */
function headingOf(b: DesignBlockDoc): string {
  return `### ${b.id}: ${b.title || (b.heading ? titleOf(b.heading, b.id) : "")}`.trimEnd();
}

/** The markdown a human and an agent read. An OUTPUT: nothing parses it back. */
export function render(doc: DesignDoc): string {
  // Parked requirements are NOT in the design the downstream steps build from -
  // that is the point of parking. They keep their place in state and appear in
  // pending-design.md instead.
  const parts = doc.blocks.filter((b) => b.state !== "parked").map((b) => {
    const open = openFor(doc, b.id).map((f) => f.id);
    const body = [
      headingOf(b),
      "",
      fieldsToText(b.fields),
      // The numbers, on the row, so a reader sees at a glance what is still
      // outstanding against this requirement - and the state below it can only
      // be `clean` when this line is empty.
      `OPEN FINDINGS: ${open.length ? open.join(", ") : "-"}`,
      `STATE: ${STATE_TEXT[b.state]}`,
    ];
    if (b.history.length > 0) {
      body.push(`HISTORY: ${b.history.map((h) => h.note).join(" · ")}`);
    }
    if (b.lineage?.length) {
      body.push("", LINEAGE_MARK, "");
      body.push(b.lineage.map((l) => quoteStructure(l.body)).join("\n\n"));
    }
    return body.filter((s) => s !== "").join("\n").trimEnd();
  });

  const tail: string[] = [];
  if (doc.unassigned.length > 0) {
    tail.push("## Review");
    tail.push(
      doc.unassigned
        .map(
          (u) =>
            `### Round ${u.round}\n\n${
              u.findings.map((x) => quoteStructure(renderFinding(x))).join("\n\n") || "_None._"
            }`,
        )
        .join("\n\n"),
    );
  }
  if (doc.decisions.length > 0) {
    tail.push("## Human decisions");
    tail.push(
      doc.decisions
        .map(
          (d) =>
            `### Gate ${d.gate} - ${d.action === "approved" ? "approved" : "revision requested"}\n\n${d.text.trim() || "_No instruction given._"}`,
        )
        .join("\n\n"),
    );
  }
  if (doc.log.length > 0) {
    tail.push("## Revision log");
    tail.push(doc.log.join("\n"));
  }
  return [doc.preamble, ...parts, ...tail].filter((s) => s && s.trim() !== "").join("\n\n") + "\n";
}

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: "OPEN",
  resolved: "RESOLVED",
  rejected: "REJECTED",
  waived: "WAIVED",
};

/** The finding register, as its own document.
 *
 * Every finding once, with where it stands and which requirements it concerns.
 * The design document carries only the numbers; the detail lives here, so
 * neither the designer nor the reviewer is re-sent a resolved finding it has
 * already dealt with. */
export function renderFindings(doc: DesignDoc): string {
  if (doc.findings.length === 0 && doc.unassigned.length === 0) {
    return "# Findings\n\n_None raised._\n";
  }
  const order: FindingStatus[] = ["open", "rejected", "resolved", "waived"];
  const out = ["# Findings", ""];
  const open = doc.findings.filter((f) => f.status === "open");
  out.push(
    `${open.length} open (${open.filter((f) => f.severity === "critical").length} critical) ` +
      `of ${doc.findings.length} raised.`,
    "",
  );
  for (const status of order) {
    const group = doc.findings.filter((f) => f.status === status);
    if (group.length === 0) continue;
    out.push(`## ${STATUS_LABEL[status]}`, "");
    for (const f of group) {
      out.push(
        `### ${f.id} (${f.severity}) - ${f.title}`,
        `- Requirements: ${f.refs.join(", ") || "-"}`,
        `- Raised: round ${f.raisedRound}${f.closedRound ? ` · closed: round ${f.closedRound}` : ""}`,
        f.needs === "decide" ? `- NEEDS A DECISION: ${f.question || "someone must answer this before it can be designed"}` : "",
        f.where ? `- Where: ${f.where}` : "",
        f.problem ? `- Problem: ${f.problem}` : "",
        f.fix ? `- Fix: ${f.fix}` : "",
        f.note ? `- Outcome: ${f.note}` : "",
        "",
      );
    }
  }
  if (doc.unassigned.length > 0) {
    out.push("## Not tied to a requirement", "");
    for (const u of doc.unassigned) {
      out.push(`### Round ${u.round}`, "", ...u.findings.map((x) => quoteStructure(renderFinding(x))), "");
    }
  }
  return out.filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/** How each requirement's design got to where it is.
 *
 * Every version, in order, with the findings that drove each change and the
 * one the human signed off. Its own document because `design.md` is sent to
 * both agents on every round: an agent needs the CURRENT design, a reader wants
 * to see how it moved and what was approved, and putting both in one file was
 * costing 150 KB of prompt per round to tell the agents something they were
 * never asked to act on. */
export function renderHistory(doc: DesignDoc): string {
  const out = ["# Design history", ""];
  const gate = doc.decisions.filter((d) => d.action === "approved").length;
  out.push(
    gate > 0
      ? `Approved at gate ${gate}. The version marked APPROVED is what was signed off.`
      : "Not yet approved - the last version of each requirement is the current one.",
    "",
  );
  for (const b of doc.blocks) {
    out.push(`## ${b.id}: ${b.title}`, "");
    const approvedHere = b.state === "approved" || b.state === "approved-objected";
    b.revisions.forEach((r, i) => {
      const last = i === b.revisions.length - 1;
      const why =
        r.round === 1 && i === 0
          ? "authored"
          : r.drivenBy.length
            ? `revised for ${r.drivenBy.join(", ")}`
            : "revised";
      const mark = last ? (approvedHere ? "  <-- APPROVED" : "  <-- current") : "";
      out.push(`### D${r.round} - ${why}${mark}`, "", fieldsToText(r.fields), "");
    });
    const open = openFor(doc, b.id).map((f) => f.id);
    out.push(
      `_State: ${STATE_TEXT[b.state]}${open.length ? ` · still open: ${open.join(", ")}` : ""}_`,
      "",
    );
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/** What moved since the reviewer last looked, field by field.
 *
 * A reviewer cannot judge whether a fix landed without seeing what changed. It
 * does not need every version of every requirement, though - it needs the
 * blocks that moved THIS round, the fields that actually differ, and the
 * findings that drove them. Bounded by what changed rather than by the size of
 * the design, and handed to the reviewer instead of buried in the document both
 * agents read. */
export function renderChanges(doc: DesignDoc, round: number): string {
  const moved = doc.blocks.filter((b) => b.revisions.some((r) => r.round === round));
  if (moved.length === 0) return "";
  const out = [`Blocks revised in round ${round}: ${moved.map((b) => b.id).join(", ")}`, ""];
  for (const b of moved) {
    const i = b.revisions.findIndex((r) => r.round === round);
    const now = b.revisions[i];
    const was = i > 0 ? b.revisions[i - 1] : null;
    out.push(
      `--- ${b.id}: ${b.title}` +
        (now.drivenBy.length ? ` (answering ${now.drivenBy.join(", ")})` : ""),
    );
    const prev = new Map((was?.fields ?? []).map((f) => [f.label, f.body]));
    let any = false;
    for (const f of now.fields) {
      if (prev.get(f.label) === f.body) continue;
      any = true;
      const before = prev.get(f.label);
      if (before !== undefined) out.push(`WAS  ${before}`);
      out.push(`NOW  ${f.body}`);
    }
    for (const [label, body] of prev) {
      if (!now.fields.some((f) => f.label === label)) {
        any = true;
        out.push(`REMOVED ${body}`);
      }
    }
    if (!any) out.push("(no field text changed)");
    out.push("");
  }
  return out.join("\n");
}

export interface ApplyReport {
  applied: string[];
  unknown: string[];
  /** "REQ-022:DESIGN" - fields refused because they deferred to absent text */
  deferred: string[];
  /** ids whose design change was refused because you approved the block */
  frozen: string[];
}

/** Merge a delta. Field-level: a field the delta does not mention is kept. */
export function applyDelta(doc: DesignDoc, delta: Delta, round: number): ApplyReport {
  const byId = new Map(doc.blocks.map((b) => [b.id, b]));
  const applied: string[] = [];
  const unknown: string[] = [];
  const deferred: string[] = [];
  const frozen: string[] = [];
  const changed = new Set<string>();
  for (const d of delta.blocks) {
    const block = byId.get(d.id);
    if (!block) {
      unknown.push(d.id);
      continue;
    }
    // An approval is the human's, and the engine enforces it rather than
    // asking. The state list already prints "do not touch" - and a revision
    // edited a block marked exactly that, because nothing stopped it. Responses
    // are still accepted: the human needs the designer's answer to an objection
    // in order to rule on it at the next gate.
    if (block.state === "approved" || block.state === "approved-objected") {
      if (d.design) frozen.push(d.id);
      if (d.responses) {
        block.lineage ??= [];
        block.lineage.push({ round, kind: "designer", body: d.responses });
        block.history.push({ round, note: `D${round}: answered, block is approved` });
        applied.push(d.id);
      }
      continue;
    }
    if (d.design) {
      // A field that defers to text it does not carry is REFUSED, and the
      // block keeps the field it already had. Accepting one replaces a real
      // design with a pointer to nothing, which is how 21 of 34 blocks were
      // gutted; refusing it is visible and recoverable, and the reviewer sees
      // that the fix did not land.
      const bad = deferringFields(d.design);
      const usable = bad.length
        ? d.design
            .split(/\n(?=[A-Z][A-Z0-9 _-]{0,30}:)/)
            .filter((chunk) => !bad.some((label) => chunk.startsWith(`${label}:`)))
            .join("\n")
        : d.design;
      if (bad.length) deferred.push(`${d.id}:${bad.join("/")}`);
      if (usable.trim()) block.fields = toFields(mergeFields(fieldsToText(block.fields), usable));
      if (d.heading) block.title = titleOf(d.heading, block.id) || block.title;
      changed.add(d.id);
    }
    if (d.responses) {
      // The response text answers findings; the block records WHICH, and the
      // register keeps the answer. "D2 revised for F24, F36" is what a reader
      // of the design needs - the argument belongs with the finding.
      const ids = [...new Set([...d.responses.matchAll(/\bF(\d+)\b/g)].map((m) => `F${m[1]}`))];
      const note = ids.length ? `D${round}: revised for ${ids.join(", ")}` : `D${round}: revised`;
      block.history.push({ round, note });
      (block.lineage ??= []).push({ round, kind: "designer", body: d.responses });
    }
    if (d.design || d.responses) applied.push(d.id);
  }
  // One snapshot per block that actually changed, tagged with the findings its
  // responses answered - so the history reads "D2, revised for F24", not just
  // "D2".
  for (const id of changed) {
    const block = byId.get(id)!;
    const answered = delta.blocks.find((d) => d.id === id)?.responses ?? "";
    const drivenBy = [...new Set([...answered.matchAll(/\bF(\d+)\b/g)].map((m) => `F${m[1]}`))];
    block.revisions.push({ round, drivenBy, fields: block.fields.map((f) => ({ ...f })) });
  }
  return { applied, unknown, deferred, frozen };
}

/** Fold a whole re-sent design in without losing anything.
 *
 * A pass that forgets it already wrote a design may re-author from scratch. Its
 * field text is taken; lineage, state and any block it omitted are kept. */
export function mergeAuthored(doc: DesignDoc, md: string): { kept: string[]; added: string[] } {
  const incoming = fromMarkdown(md);
  const byId = new Map(doc.blocks.map((b) => [b.id, b]));
  const kept: string[] = [];
  const added: string[] = [];
  for (const fresh of incoming.blocks) {
    const block = byId.get(fresh.id);
    if (!block) {
      doc.blocks.push(fresh);
      added.push(fresh.id);
      continue;
    }
    block.title = fresh.title || block.title;
    block.fields = toFields(mergeFields(fieldsToText(block.fields), fieldsToText(fresh.fields)));
  }
  const seen = new Set(incoming.blocks.map((b) => b.id));
  for (const b of doc.blocks) if (!seen.has(b.id)) kept.push(b.id);
  if (incoming.preamble.trim()) doc.preamble = incoming.preamble;
  return { kept, added };
}

/** Fold one review round in: findings under the requirements they name, states
 * recomputed, the open set carried forward, one log row. */
/** Findings still open against a requirement. */
export function openFor(doc: DesignDoc, id: string): FindingEntry[] {
  return doc.findings.filter((f) => f.status === "open" && f.refs.includes(id));
}

/** Open findings the DESIGN can still close. What the loop is actually for. */
export function fixableOpen(doc: DesignDoc): FindingEntry[] {
  const parked = new Set(doc.blocks.filter((b) => b.state === "parked").map((b) => b.id));
  return doc.findings.filter(
    (f) =>
      f.status === "open" &&
      f.needs !== "decide" &&
      !(f.refs.length > 0 && f.refs.every((r) => parked.has(r))),
  );
}

/** Open findings waiting on a human. What the gate should hand over. */
export function decisionsOpen(doc: DesignDoc): FindingEntry[] {
  return doc.findings.filter((f) => f.status === "open" && f.needs === "decide");
}

/** Recompute every block's state from the finding register.
 *
 * A SEPARATE pass, run after a review has been folded in - never as a side
 * effect of one round. The old rule asked "did THIS round's findings name this
 * block?", so a requirement carrying F12 open since round 1 turned `clean` in
 * round 2 the moment the reviewer did not re-mention it. One finding being
 * fixed is not the requirement being cleared: a block is clean only when
 * NOTHING is open against it.
 *
 * `approved` is the human's word and no review takes it away - an open finding
 * against an approved block makes it `approved - reviewer objects`, and only
 * the human rules on that. */
export function recomputeStates(doc: DesignDoc): void {
  for (const b of doc.blocks) {
    // Parking is the human's decision, exactly like approval: a review does not
    // undo it. The block is out of this run.
    if (b.state === "parked") continue;
    const stillOpen = openFor(doc, b.id).length > 0;
    const wasApproved = b.state === "approved" || b.state === "approved-objected";
    b.state = wasApproved
      ? stillOpen
        ? "approved-objected"
        : "approved"
      : stillOpen
        ? "open"
        : "clean";
  }
}

export function recordReview(doc: DesignDoc, rec: ReviewRecord): { unassigned: Finding[] } {
  const byId = new Map(doc.blocks.map((b) => [b.id, b]));
  const known = new Map(doc.findings.map((f) => [f.id, f]));
  const unassigned: Finding[] = [];
  const raised: string[] = [];

  for (const f of rec.findings) {
    const targets = f.refs.filter((r) => byId.has(r));
    if (targets.length === 0) {
      unassigned.push(f);
      continue;
    }
    const cls = classifyFinding([f.title, f.where, f.problem, f.fix].join("\n"));
    const existing = known.get(f.id);
    if (existing) {
      // re-raised: it is open again, whatever it was, and may have grown refs
      existing.status = "open";
      existing.closedRound = undefined;
      existing.refs = [...new Set([...existing.refs, ...targets])];
      existing.needs = cls.needs;
      existing.question = cls.question;
    } else {
      const entry: FindingEntry = {
        id: f.id,
        severity: f.severity,
        refs: targets,
        title: f.title,
        where: f.where,
        problem: f.problem,
        fix: f.fix,
        status: "open",
        needs: cls.needs,
        question: cls.question,
        raisedRound: rec.round,
      };
      doc.findings.push(entry);
      known.set(f.id, entry);
      raised.push(f.id);
    }
  }

  for (const id of rec.closed) {
    const e = known.get(id);
    if (!e || e.status !== "open") continue;
    e.status = "resolved";
    e.closedRound = rec.round;
    e.note = `reported resolved in review round ${rec.round}`;
  }

  // State is derived, in its own pass, from what is STILL open.
  recomputeStates(doc);

  for (const b of doc.blocks) {
    const mine = openFor(doc, b.id).map((f) => f.id);
    const note = mine.length ? `R${rec.round}: open ${mine.join(", ")}` : `R${rec.round}: clean`;
    if (b.history.at(-1)?.note !== note) b.history.push({ round: rec.round, note });
  }

  if (unassigned.length > 0) doc.unassigned.push({ round: rec.round, findings: unassigned });

  const open = doc.findings.filter((f) => f.status === "open");
  const crit = open.filter((f) => f.severity === "critical").length;
  doc.log.push(
    `- Round ${rec.round}: ${rec.verdict}, ${open.length} open (${crit} critical)` +
      (raised.length ? `, raised ${raised.join(", ")}` : "") +
      (rec.closed.length ? `, closed ${rec.closed.join(", ")}` : ""),
  );
  doc.openFindings = open.map((f) => f.id);
  return { unassigned };
}

/** Requirements that cannot be finished, and are not the design's fault.
 *
 * A block qualifies when everything still open against it needs a human -
 * another team's schema answer, a business rule the source document leaves
 * undecided. Redesigning cannot close those, so holding the whole epic for
 * them means nothing ships. A block with any `fix` finding left is NOT
 * parkable: it is simply unfinished. */
export function parkable(doc: DesignDoc): DesignBlockDoc[] {
  return doc.blocks.filter((b) => {
    if (b.state === "parked") return false;
    const open = openFor(doc, b.id);
    return open.length > 0 && open.every((f) => f.needs === "decide");
  });
}

/** Set aside the blocked requirements so the rest can proceed.
 *
 * Nothing is deleted: a parked block keeps its design, its history and its
 * findings, and moves to `pending-design.md` with the questions that stopped
 * it. When the answers come back it is picked up in a later run. */
export function parkBlocks(doc: DesignDoc, ids: string[], gate: number): string[] {
  const wanted = new Set(ids);
  const done: string[] = [];
  for (const b of doc.blocks) {
    if (!wanted.has(b.id) || b.state === "parked") continue;
    b.state = "parked";
    const qs = openFor(doc, b.id).map((f) => f.id);
    b.history.push({ round: gate, note: `parked at gate ${gate}: awaiting ${qs.join(", ")}` });
    done.push(b.id);
  }
  return done;
}

/** The requirements that did not make this cut, and what each is waiting on.
 *
 * Written for a human to act on: the design as far as it got, the open
 * question, and who has to answer it. This is the list that goes back to the
 * customer before build starts. */
export function renderPending(doc: DesignDoc): string {
  const parked = doc.blocks.filter((b) => b.state === "parked");
  if (parked.length === 0) return "# Pending designs\n\n_Nothing is parked - every requirement proceeded._\n";
  const out = [
    "# Pending designs",
    "",
    `${parked.length} of ${doc.blocks.length} requirements are held back. Each is blocked on a`,
    "decision nobody in the design loop can make. The design so far is kept; when the",
    "answers come back, these can be picked up without redoing the work.",
    "",
  ];
  for (const b of parked) {
    const open = openFor(doc, b.id);
    out.push(`## ${b.id}: ${b.title}`, "");
    out.push("**Waiting on**", "");
    for (const f of open) {
      out.push(
        `- **${f.id}** (${f.severity}) — ${f.question || f.title}`,
        f.problem ? `  - Why it blocks: ${f.problem}` : "",
      );
    }
    out.push("", "**Design so far**", "", fieldsToText(b.fields), "");
  }
  return out.filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/** Record a gate decision. Approval is the only thing that freezes a block. */
export function recordDecision(
  doc: DesignDoc,
  entry: { action: "approved" | "revise"; text: string; freeze?: boolean },
): void {
  doc.decisions.push({
    gate: doc.decisions.length + 1,
    action: entry.action,
    text: entry.text,
  });
  if (entry.freeze && entry.action === "approved") {
    for (const b of doc.blocks) b.state = "approved";
  }
}

const jsonPath = (rel: string) => rel.replace(/\.md$/, "") + ".json";

/** Load the state. Falls back to adopting a markdown design written before this
 * structure existed, so an in-flight run is never stranded. */
export async function load(root: string, rel: string): Promise<DesignDoc | null> {
  const abs = path.join(root, jsonPath(rel));
  const raw = await fs.readFile(abs, "utf8").catch(() => "");
  if (raw.trim()) {
    try {
      const doc = JSON.parse(raw) as DesignDoc;
      if (doc && Array.isArray(doc.blocks)) {
        doc.findings ??= [];
        doc.unassigned ??= [];
        doc.decisions ??= [];
        doc.log ??= [];
        doc.openFindings ??= [];
        for (const f of doc.findings) f.needs ??= "fix";
        for (const b of doc.blocks) {
          b.history ??= [];
          b.revisions ??= [{ round: 1, drivenBy: [], fields: b.fields }];
        }
        return doc;
      }
    } catch {
      /* fall through and adopt the markdown */
    }
  }
  const md = await fs.readFile(path.join(root, rel), "utf8").catch(() => "");
  return md.trim() ? fromMarkdown(md) : null;
}

/** Write the state, then the document rendered from it. */
export async function save(root: string, rel: string, doc: DesignDoc): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const dir = path.dirname(abs);
  await fs.writeFile(path.join(root, jsonPath(rel)), JSON.stringify(doc, null, 2) + "\n", "utf8");
  // One state, three views: what an agent works from, where every finding
  // stands, and how each requirement's design got to where it is.
  await fs.writeFile(abs, render(doc), "utf8");
  await fs.writeFile(path.join(dir, "findings.md"), renderFindings(doc), "utf8");
  await fs.writeFile(path.join(dir, "design-history.md"), renderHistory(doc), "utf8");
  await fs.writeFile(path.join(dir, "pending-design.md"), renderPending(doc), "utf8");
}

/** `…design.md` -> `…design-v1.md`, then -v2. The rollback copy; nothing reads
 * it, and it is what would have recovered a run that lost three rounds. */
async function archive(root: string, rel: string): Promise<void> {
  const abs = path.join(root, rel);
  const current = await fs.readFile(abs, "utf8").catch(() => "");
  if (!current.trim()) return;
  const dir = path.dirname(abs);
  const base = path.basename(abs).replace(/\.md$/, "");
  for (let n = 1; n < 100; n++) {
    const p = path.join(dir, `${base}-v${n}.md`);
    const taken = await fs.stat(p).then(() => true).catch(() => false);
    if (!taken) {
      await fs.writeFile(p, current, "utf8").catch(() => {});
      return;
    }
  }
}

export interface DesignWrite {
  mode: "authored" | "delta" | "merged" | "refused";
  applied: string[];
  unknown: string[];
  kept: string[];
  added: string[];
  note: string;
}

/** The design write path: one entry point, non-destructive by construction.
 *
 * A delta touches only the blocks it names and only the fields it sends; a
 * whole re-sent design may replace field text but never lineage, state, or a
 * block it forgot. Nothing a pass omits can be lost by being omitted. */
export async function writeUpdate(
  root: string,
  rel: string,
  produced: string,
  round: number,
  delta: Delta,
): Promise<DesignWrite> {
  const none: DesignWrite = {
    mode: "refused",
    applied: [],
    unknown: [],
    kept: [],
    added: [],
    note: "",
  };
  if (delta.mode === "none") {
    return { ...none, note: `${rel} left as it was - the step produced no design` };
  }
  const doc = await load(root, rel);
  if (!doc) {
    if (delta.mode === "delta") {
      return {
        ...none,
        note: `${rel} not written - the step sent a DELTA but no design exists yet to apply it to`,
      };
    }
    await save(root, rel, fromMarkdown(delta.body));
    return { ...none, mode: "authored", note: `${rel} authored` };
  }
  const before = new Set(doc.blocks.map((b) => b.id));
  const out: DesignWrite = { ...none };
  if (delta.mode === "delta") {
    const r = applyDelta(doc, delta, round);
    out.mode = "delta";
    out.applied = r.applied;
    out.unknown = r.unknown;
    out.note =
      `${rel}: ${r.applied.length} block(s) revised` +
      (r.unknown.length ? `; unknown id(s) ignored: ${r.unknown.join(", ")}` : "") +
      (r.frozen.length ? `; design edit refused on approved block(s): ${r.frozen.join(", ")}` : "") +
      (r.deferred.length ? `; field(s) refused as placeholders: ${r.deferred.join(", ")}` : "");
  } else {
    const m = mergeAuthored(doc, delta.body);
    out.mode = "merged";
    out.kept = m.kept;
    out.added = m.added;
    out.note =
      `${rel}: a whole design was re-sent instead of a delta - field text taken, ` +
      `all review history kept` +
      (m.kept.length ? `; ${m.kept.length} block(s) it omitted were preserved: ${m.kept.join(", ")}` : "") +
      (m.added.length ? `; new block(s): ${m.added.join(", ")}` : "");
  }
  const now = new Set(doc.blocks.map((b) => b.id));
  const dropped = [...before].filter((id) => !now.has(id));
  if (dropped.length > 0) {
    return { ...none, note: `${rel} NOT written - the revision would have dropped ${dropped.join(", ")}` };
  }
  await archive(root, rel);
  await save(root, rel, doc);
  return out;
}

/** Fold one review round into the document and report what moved.
 *
 * `closed` is measured against the open set the document CARRIES, never against
 * findings re-read out of its own rendering - the inference that reported 39 of
 * 33 findings closed and left the loop unable to stall. */
export async function foldReview(
  root: string,
  rel: string,
  reviewOutput: string,
  round: number,
  findings: Finding[],
  said: { resolved: Set<string>; partial: Set<string>; stillOpen: Set<string> },
): Promise<{
  rec: ReviewRecord;
  unassigned: Finding[];
  openCount: number;
  fixableCount: number;
  decisions: FindingEntry[];
} | null> {
  const doc = await load(root, rel);
  if (!doc) return null;
  const nowIds = new Set(findings.map((f) => f.id));
  const rec: ReviewRecord = {
    round,
    verdict: /VERDICT:\s*(APPROVED|PASS)/i.test(reviewOutput) ? "pass" : "needs_work",
    findings,
    closed: doc.openFindings.filter(
      (id) =>
        !said.partial.has(id) &&
        !said.stillOpen.has(id) &&
        (said.resolved.has(id) || !nowIds.has(id)),
    ),
  };
  const { unassigned } = recordReview(doc, rec);
  await save(root, rel, doc);
  return {
    rec,
    unassigned,
    openCount: doc.openFindings.length,
    fixableCount: fixableOpen(doc).length,
    decisions: decisionsOpen(doc),
  };
}

/** Record a gate decision against the document the gate was ruling on. */
export async function foldDecision(
  root: string,
  rel: string,
  entry: { action: "approved" | "revise"; text: string; freeze?: boolean },
): Promise<boolean> {
  const doc = await load(root, rel);
  if (!doc) return false;
  recordDecision(doc, entry);
  await save(root, rel, doc);
  return true;
}
