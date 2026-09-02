import { parseFindings, verdictOf } from "@/lib/findings";
import { statedOutcomes, type ReviewRecord } from "./artifacts";
import { foldReview } from "./designDoc";
import type { RunState, StepDef, StepState, WorkflowDef } from "./schema";

/** The review-verdict layer: how a reviewer's output becomes recorded rounds,
 * and what holds an auto-approved gate back. Extracted so the fail-closed
 * rules live in one place - three different executor paths call into this,
 * and keeping them 800 lines apart in one file is how one of them ended up
 * not recording at all. */

export async function recordRound(
  run: RunState,
  rel: string,
  reviewOutput: string,
  round: number,
  step: StepState,
): Promise<ReviewRecord | null> {
  try {
    const findings = parseFindings(reviewOutput).findings;
    const nowIds = new Set(findings.map((f) => f.id));
    // What the reviewer SAID beats what the engine can infer. A finding it
    // called PARTIAL or STILL OPEN stays open even when it dropped out of the
    // findings list; absence only closes a finding it said nothing about.
    const said = statedOutcomes(reviewOutput);
    const folded = await foldReview(run.root, rel, reviewOutput, round, findings, said);
    if (!folded) return null;
    const disputed = [...said.partial, ...said.stillOpen].filter((id) => !nowIds.has(id));
    if (disputed.length > 0) {
      step.output +=
        `
[engine] kept open on the reviewer's own word: ${disputed.join(", ")} - ` +
        `reported PARTIAL or STILL OPEN but absent from the findings list.`;
    }
    if (folded.unassigned.length > 0 && findings.length > folded.unassigned.length) {
      step.output +=
        `\n[engine] ${folded.unassigned.length} finding(s) name no requirement and were filed ` +
        `under "## Review": ${folded.unassigned.map((f) => f.id).join(", ")}`;
    }
    step.output +=
      `\n[engine] ${folded.openCount} finding(s) open after round ${round}` +
      (folded.rec.closed.length ? `, closed ${folded.rec.closed.length} this round` : "") +
      ` - ${folded.fixableCount} the design can close, ${folded.decisions.length} needing a decision.`;
    if (folded.decisions.length > 0) {
      step.output +=
        `\n[engine] awaiting a human decision (the design cannot close these): ` +
        folded.decisions.map((f) => `${f.id} - ${f.question ?? f.title}`.slice(0, 120)).join(" | ");
    }
    // A round that leaves nothing the design can close has finished its job.
    // Chasing zero spends rounds failing to design around information nobody
    // has: on run d0e4f7bc-1d6 five findings sat open to the last round waiting
    // on another team's schema answer.
    if (folded.fixableCount === 0 && folded.decisions.length > 0) {
      step.output +=
        `\n[engine] nothing left that the design can close - the remaining ` +
        `${folded.decisions.length} finding(s) need a human. Over to you at the gate.`;
    }
    return folded.rec;
  } catch {
    return null; // the artifact is best-effort; never break a run over it
  }
}

/** Appended to a read-only step's output when the working tree changed during
 * it. A review carrying this mark is treated as blocked by the auto-gate. */
export const READONLY_WROTE_MARK = "[engine] READ-ONLY VIOLATION:";

/** Did the review immediately before this gate end unresolved?
 *
 * Looks back from the gate to the nearest review-role step and reads its
 * verdict. Returns a short reason when the gate must NOT auto-approve, or ""
 * when it may. FAIL-CLOSED: a review that RAN but declared no parseable
 * verdict blocks the auto-gate (quoted text or an omitted line must not
 * launder a blocked review into an approval); only a review that never ran -
 * skipped, or empty output - abstains. */
export function blockedReviewBefore(run: RunState, def: WorkflowDef, gateIndex: number): string {
  for (let k = gateIndex - 1; k >= 0; k--) {
    const d = def.steps[k];
    if (d.type === "gate") break; // an earlier gate already had its own say
    if (d.type !== "agent" || d.role !== "review") continue;
    const state = run.steps.find((s) => s.id === d.id);
    const out = state?.output ?? "";
    // a "read-only" review that wrote files has forfeited its gating power -
    // whatever verdict it printed, a human decides, not the auto-gate
    if (out.includes(READONLY_WROTE_MARK)) {
      return `${d.id}: the read-only review modified project files - blocked`;
    }
    const verdict = verdictOf(out);
    if (!verdict) {
      // Fail CLOSED - but only for a review that was INSTRUCTED to declare a
      // verdict (emits: "findings" appends that contract to its prompt). Such
      // a review that ran without a parseable verdict must not wave the
      // auto-gate through: the old fail-open reading let quoted text (or an
      // injected reviewer simply omitting the line) launder a blocked review
      // into an auto-approval. A review-role step with no declared contract
      // was never told to emit one, so its silence stays an abstention -
      // fail-closed there would permanently block autoGate on custom steps.
      return d.emits === "findings" && state && state.status !== "skipped" && out.trim()
        ? `${d.id}: produced no VERDICT line - treated as blocked`
        : "";
    }
    if (verdict === "APPROVED" || verdict === "PASS") return "";
    const open = parseFindings(out).findings.filter((f) => f.severity === "critical").length;
    return open > 0
      ? `${d.id}: ${verdict}, ${open} critical finding${open === 1 ? "" : "s"} open`
      : `${d.id}: ${verdict}`;
  }
  return "";
}

/** A declared contract that produced nothing parseable is a FAILURE, not a
 * quiet fallback. This is the exact shape of the bug that started all of it: a
 * review yielding zero parseable findings degraded to a text slice, and the
 * rework was handed 4,000 characters of terminal trace instead. */
export function contractHeld(def: StepDef, output: string): string {
  if (def.emits === "findings") {
    if (parseFindings(output).findings.length > 0) return "";
    const v = verdictOf(output);
    if (v === "APPROVED" || v === "PASS") return ""; // a clean pass has none
    return `declared emits: "findings" but produced no parseable finding and no passing verdict`;
  }
  if (def.emits === "coverage") {
    return /COVERAGE:\s*(COMPLETE|INCOMPLETE)/i.test(output)
      ? ""
      : `declared emits: "coverage" but produced no COVERAGE: line`;
  }
  return "";
}
