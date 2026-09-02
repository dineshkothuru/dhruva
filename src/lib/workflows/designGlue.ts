import path from "node:path";
import { promises as fs } from "node:fs";
import { resolveInside } from "@/lib/fsguard";
import { checkEvidence, evidenceNote } from "./evidenceCheck";
import type { BlockState } from "./artifacts";
import {
  awaitingDecision,
  foldDecision,
  load as loadDesignDoc,
  openFor,
  parkable,
  parkBlocks,
  recordCards,
  recordDecision as recordDocDecision,
  render as renderDesign,
  renderChanges,
  renderOpenFindings,
  save as saveDesignDoc,
} from "./designDoc";
import { template, toPosix } from "./templating";
import type { RunState, StepDef, WorkflowDef } from "./schema";

/** The glue between the executor and the design document: gate rulings folded
 * into the doc, artifacts adopted or written, and the prompt blocks that hand
 * an agent its own previous work. Extracted from the engine so the document
 * lifecycle can be read as one story. */

/** The nearest agent step before index i - the step a gate's revision re-runs. */
export function nearestAgentIndex(def: WorkflowDef, i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (def.steps[j].type === "agent") return j;
  }
  return -1;
}

/** Fold the human's per-card rulings into the design, and turn the cards they
 * sent back into one instruction the designer and the reviewer both read.
 *
 * The instruction names the requirement in front of each note. A note without
 * its id is advice about nothing: the designer gets the whole set at once and
 * has to know which block each line rules on. */
export async function applyCards(
  run: RunState,
  def: WorkflowDef,
  gateIndex: number,
  cards: { id: string; verdict: "approve" | "revise"; note?: string }[],
): Promise<{ approved: string[]; revising: string[]; instruction: string }> {
  const none = { approved: [], revising: [], instruction: "" };
  if (cards.length === 0) return none;
  const targetId =
    def.steps[gateIndex].reviseTarget ?? def.steps[nearestAgentIndex(def, gateIndex)]?.id;
  const rel = run.steps.find((s) => s.id === targetId)?.artifact;
  if (!rel) return none;
  const doc = await loadDesignDoc(run.root, toPosix(rel)).catch(() => null);
  if (!doc) return none;
  const gate = doc.decisions.length + 1;
  const { approved, revising } = recordCards(doc, gate, cards);
  await saveDesignDoc(run.root, toPosix(rel), doc).catch(() => {});
  const lines: string[] = [];
  for (const c of cards) {
    const note = c.note?.trim();
    if (c.verdict === "revise") lines.push(`${c.id}: ${note || "rework this requirement."}`);
    else if (note) lines.push(`${c.id} (APPROVED - do not rework): ${note}`);
  }
  const instruction = lines.length
    ? [`The human ruled on individual requirements at gate ${gate}:`, "", ...lines].join("\n") +
      (approved.length
        ? `\n\nApproved and frozen: ${approved.join(", ")}. Leave those blocks out of your delta.`
        : "")
    : "";
  return { approved, revising, instruction };
}

/** Park every requirement that is blocked only on a human decision.
 *
 * The design keeps its work; the parked blocks move to `pending-design.md`
 * with the questions that stopped them, and the rest of the pipeline builds
 * documents from what proceeded. When the answers come back they are picked up
 * in a later run rather than redesigned. */
export async function parkAtGate(run: RunState, def: WorkflowDef, gateIndex: number): Promise<string[]> {
  const targetId =
    def.steps[gateIndex].reviseTarget ?? def.steps[nearestAgentIndex(def, gateIndex)]?.id;
  const rel = run.steps.find((s) => s.id === targetId)?.artifact;
  if (!rel) return [];
  const doc = await loadDesignDoc(run.root, toPosix(rel)).catch(() => null);
  if (!doc) return [];
  const gate = doc.decisions.length + 1;
  const ids = parkable(doc).map((b) => b.id);
  if (ids.length === 0) return [];
  const parked = parkBlocks(doc, ids, gate);
  recordDocDecision(doc, {
    action: "approved",
    text:
      `Proceeded with the requirements that were ready. Parked ${parked.length} blocked on a ` +
      `decision: ${parked.join(", ")}. See pending-design.md.`,
  });
  await saveDesignDoc(run.root, toPosix(rel), doc).catch(() => {});
  return parked;
}

/** Bring an existing document into a run whose producing step was skipped.
 *
 * Skipping the WORK must not skip the OUTPUT: every downstream step still
 * quotes `{steps.requirements.output}` and still expects the file where the
 * step would have written it. So the named file is copied to the step's own
 * artifact path, and from there the run cannot tell the difference. */
export async function adoptArtifact(
  run: RunState,
  def: StepDef,
  source: string,
): Promise<{ ok: boolean; note: string }> {
  const no = (why: string) => ({ ok: false, note: `[engine] ${why} - running the step instead.` });
  if (!def.artifact) return no("nothing to adopt into");
  const rel = template(def.artifact, run).replace(/\\/g, "/");

  // `true` means "use what was attached to this run". Anything else is a path.
  const candidates: string[] = [];
  if (source === "true") {
    const dir = path.join(run.root, ".dhruva", "runs", run.runId, "attachments");
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (/\.(md|markdown|txt)$/i.test(name)) candidates.push(path.join(dir, name));
    }
    if (candidates.length === 0) return no("no attached text file to adopt");
  } else {
    const src = resolveInside(run.root, toPosix(source.trim()));
    if (!src) return no(`"${source}" is outside this project`);
    candidates.push(src);
  }

  // It must LOOK like what the step would have produced. On a real run the BRD
  // extract was attached instead of a requirement list; adopting a 151 KB
  // source document as "the frozen requirements" would have had every later
  // step citing nonsense. The wrong file costs the four minutes it was meant to
  // save, and nothing else.
  const shape = /^###[ \t]+REQ-\d+/m;
  for (const src of candidates) {
    const body = await fs.readFile(src, "utf8").catch(() => "");
    const name = path.basename(src);
    if (!body.trim()) continue;
    if (!shape.test(body)) {
      return no(`"${name}" is not a requirement list (no "### REQ-nnn" blocks)`);
    }
    const abs = resolveInside(run.root, rel);
    if (!abs) return no(`artifact path "${rel}" escapes the project`);
    await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
    await fs.writeFile(abs, body, "utf8").catch(() => {});
    const n = (body.match(/^###[ \t]+REQ-\d+/gm) ?? []).length;
    return {
      ok: true,
      note:
        `[engine] step skipped - adopted ${name} as ${rel} ` +
        `(${n} requirement(s), ${(body.length / 1024).toFixed(1)}k chars). Nothing was re-extracted.`,
    };
  }
  return no("none of the attached files could be read");
}

/** Write a gate's decision into the document the gate was ruling on.
 *
 * The document is the one owned by the gate's revise target - the step whose
 * work is being judged. `freeze` stamps every block `approved` on a real human
 * approval, which is the only place that state is ever set: an auto-approved
 * run has not been ruled on by anyone, so it freezes nothing. */
export async function recordDecision(
  run: RunState,
  def: WorkflowDef,
  gateIndex: number,
  action: "approved" | "revise",
  text: string,
  freeze = false,
): Promise<void> {
  const targetId = def.steps[gateIndex].reviseTarget ?? def.steps[nearestAgentIndex(def, gateIndex)]?.id;
  const rel = run.steps.find((s) => s.id === targetId)?.artifact;
  if (!rel) return;
  await foldDecision(run.root, rel, { action, text, freeze }).catch(() => false);
}

/** Is this artifact THE design - the one document the engine owns as state?
 *
 * Named by its path rather than by a step flag on purpose: the design's path is
 * what every other part of the machinery keys on (write-doc reads it, the
 * reviewer quotes it, the gate cards are built from it), so one rule about the
 * path keeps them all agreeing. */
export function isDesignArtifact(rel: string): boolean {
  return /(^|\/)design\.md$/i.test(rel);
}

/** Write a document artifact exactly as its author wrote it.
 *
 * `rel` comes out of template() and can carry run INPUTS - contained like
 * every other expanded path, so a custom workflow's artifact template can
 * never write outside the attached project. Thrown errors fail the step
 * (the executor's try around runStepTracked). */
export async function writePlainArtifact(root: string, rel: string, body: string): Promise<void> {
  const abs = resolveInside(root, rel);
  if (!abs) throw new Error(`artifact path "${rel}" escapes the project - refused`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body.endsWith("\n") ? body : body + "\n", "utf8");
}

/** The design document, for the END of the prompt.
 *
 * It used to sit inside the state block, ahead of the step's own instructions.
 * On run d0e4f7bc-1d6 that put 88 KB of document between the agent and its
 * task: the instructions began at offset 93,720 of a 147 KB prompt, and the
 * revision that read it skimmed - it declared 32 of 34 blocks unchanged,
 * ignored all 22 the engine had listed as open, and edited one marked "do not
 * touch". The authoring pass, which inlines no document, had worked properly on
 * the same model minutes earlier.
 *
 * So: task first, data last, and a one-line restatement after the data. The
 * reviewer's prompt was already built this way and did not suffer. */
export async function designDocumentBlock(run: RunState, def: StepDef): Promise<string> {
  if (!def.artifact) return "";
  const rel = toPosix(template(def.artifact, run));
  const doc = await loadDesignDoc(run.root, rel).catch(() => null);
  if (!doc || doc.blocks.length === 0) return "";
  // The claims themselves, not just their numbers. design.md carries only the
  // ids on each block, and the auto-revise loop skips injecting findings when
  // the target has an artifact - correct while findings were filed inline,
  // wrong once they moved into their own register. Round 2 of run
  // 60975f36-bba got ten ids and no claims, said it would rather emit an empty
  // delta than invent verdicts, and revised zero of thirty-four blocks.
  const findings = renderOpenFindings(doc);
  return (
    (findings
      ? `\n\n--- OPEN FINDINGS you must answer (${doc.findings.filter((f) => f.status === "open").length}) ---\n` +
        `${findings}\n--- end open findings ---\n`
      : "") +
    `\n\n--- CURRENT DESIGN DOCUMENT (reference; the task is stated above) ---\n` +
    `${renderDesign(doc)}\n` +
    `--- end design document ---\n\n` +
    `Now produce the DELTA exactly as instructed above: only the blocks you changed ` +
    `or are answering a finding on, each field complete, and a response to EVERY id ` +
    `on that block's OPEN FINDINGS line.\n`
  );
}

/** Tell an authoring step, in its own prompt, whether it is writing a design
 * or revising one - and hand it the document rather than asking it to look.
 *
 * Run 1e3dc542-bbc round 4: the step's glob does not traverse dot-directories,
 * so `.dhruva/runs/<id>/docs/design.md` came back "No matches found", the agent
 * concluded no prior design existed, and re-authored from scratch - discarding
 * three rounds of accepted fixes. Rounds 2 and 3 hit the same empty glob and
 * only recovered because they happened to keep digging with a directory
 * listing. A step must not have to FIND its own previous work, so the engine
 * inlines it and says which blocks are in play. */
export async function designStateBlock(run: RunState, def: StepDef): Promise<string> {
  // A review step gets the other half of the picture: what moved since it last
  // looked. Without it a reviewer can read the current design and the fix the
  // designer claims to have made, but cannot see whether the text actually
  // changed - so it cannot tell a real fix from a restated one.
  if (!def.artifact && def.reviewOf) {
    const target = run.steps.find((s) => s.id === def.reviewOf);
    if (!target?.artifact) return "";
    const doc = await loadDesignDoc(run.root, toPosix(target.artifact)).catch(() => null);
    if (!doc) return "";
    const round = (target.attempts?.length ?? 0) + 1;
    const diff = renderChanges(doc, round);
    return diff
      ? `\n\n=== CHANGED SINCE YOUR LAST REVIEW (round ${round}) ===\n${diff}` +
          `=== END CHANGES ===\n\n`
      : "";
  }
  if (!def.artifact) return "";
  const rel = toPosix(template(def.artifact, run));
  const doc = await loadDesignDoc(run.root, rel).catch(() => null);
  const current = doc ? renderDesign(doc) : "";
  if (!doc || doc.blocks.length === 0 || !current.trim()) {
    return (
      `\n\n=== DESIGN STATE ===\n` +
      `No design exists for this run yet. You are AUTHORING: output the complete ` +
      `design, one block per requirement, inside the DESIGN fence. Do NOT emit a DELTA.\n` +
      `=== END DESIGN STATE ===\n\n`
    );
  }
  const by = (want: BlockState) => doc.blocks.filter((b) => b.state === want).map((b) => b.id);
  // Split "open" by WHY, because the two need opposite things from the
  // designer: a block with findings gets fixed or defended; a block held only
  // by its own OPEN-CONFIRMED has nothing to answer and must be left alone for
  // the human, not quietly settled to clear the state.
  const waiting = doc.blocks
    .filter((b) => b.state === "open" && openFor(doc, b.id).length === 0 && awaitingDecision(b))
    .map((b) => b.id);
  const isWaiting = new Set(waiting);
  const line = (label: string, list: string[]) =>
    list.length ? `  ${label.padEnd(28)} ${list.join(", ")}\n` : "";
  // A fact the engine established, handed over before the next pass rather than
  // left for a review round to discover.
  const ev = await checkEvidence(run.root, current).catch(() => null);
  const evLine = ev && ev.missing.length ? `\nENGINE CHECK - ${evidenceNote(ev)}\nFix these blocks.\n` : "";
  return (
    `\n\n=== DESIGN STATE ===\n` +
    `You are REVISING. The complete current design is at the END of this prompt - ` +
    `it is the authoritative copy, so do NOT search the filesystem for it.\n\n` +
    line("open", by("open").filter((id) => !isWaiting.has(id))) +
    line("awaiting a decision", waiting) +
    line("approved - reviewer objects", by("approved-objected")) +
    line("clean (do not touch)", by("clean")) +
    line("approved (do not touch)", by("approved")) +
    evLine +
    `=== END DESIGN STATE ===\n\n` +
    // The document itself is returned separately - see designDocumentBlock.
    ""
  );
}

/** The design text a work-check should read.
 *
 * Named explicitly by the step rather than inferred: `artifact` for a workflow
 * whose design step writes a curated document, `reviewOf` for one whose design
 * lives in the step output. Both are existing conventions, and being explicit
 * matters here more than convenience - this is the input to a decision that can
 * end a run, so it must be obvious from the workflow file which text drives it.
 *
 * The artifact wins when both are present: it is the curated design, whereas
 * the output is a transcript that happens to contain one. */
export async function designText(run: RunState, def: StepDef): Promise<string> {
  if (def.artifact) {
    const abs = resolveInside(run.root, toPosix(template(def.artifact, run)));
    if (abs) {
      const text = await fs.readFile(abs, "utf8").catch(() => "");
      if (text.trim()) return text;
    }
  }
  if (def.reviewOf) {
    return run.steps.find((s) => s.id === def.reviewOf)?.output ?? "";
  }
  return "";
}
