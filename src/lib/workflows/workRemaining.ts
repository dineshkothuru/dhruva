/** Does the approved design actually leave any work to do?
 *
 * A feature-dev run for "create a Student object" was reported as FAILED having
 * done nothing wrong. An earlier run had already created the object, its fields,
 * the permission set and the tests, so the implement agent correctly concluded
 * there was nothing to add and reported PRODUCED: nothing. The change set was
 * then empty, and the run died at the check-only deploy with "no changed files
 * to act on" - reading as a broken run when nothing was broken.
 *
 * Failing was the visible bug, but running implement at all was the real one.
 * The design phase already knows what exists and what is missing: solution
 * design records STATUS / ALREADY-PRESENT / PENDING per requirement. If every
 * requirement is already implemented, the honest thing is to say so and close
 * the run - not to drive an agent through an implementation with nothing to
 * implement, and then to fail on the emptiness that follows.
 *
 * This is deliberately a COUNT, not a judgement. The design states a status per
 * item; this only adds them up. */

export type WorkVerdict = "none" | "some" | "unknown";

export interface WorkReport {
  verdict: WorkVerdict;
  /** requirement/use-case items the design declared */
  total: number;
  /** items declared already implemented, needing no work */
  satisfied: number;
  /** ids that still carry work, for the message */
  pendingIds: string[];
  /** how the verdict was reached, for the step output */
  basis: string;
}

/** Solution design's per-requirement block: "STATUS: ALREADY IMPLEMENTED".
 * Anchored to the line so prose mentioning the phrase cannot register. */
const STATUS_LINE = /^\s*\**STATUS\**\s*:\s*(ALREADY IMPLEMENTED|PARTIAL|NEW)\b/im;
const REQ_ID = /^\s*\**(REQ-\d+|UC-E?\d+)\**\s*:/i;

/** The single-line contract for workflows whose design step is a spec rather
 * than a per-requirement artifact. */
const WORK_REMAINING_LINE = /^\s*\**WORK-REMAINING\**\s*:\s*(NONE|SOME)\b/im;

/** The instruction that puts that line in a design prompt. One source, so the
 * prompt and the parser cannot drift apart. */
export const WORK_INSTRUCTION = [
  "Finally, state on its own line whether this design leaves any work to do:",
  "WORK-REMAINING: NONE | SOME",
  "Use NONE only when every use case above is ALREADY fully implemented in this",
  "codebase, each with concrete evidence you have read (exact file paths), and the",
  "FILES line is therefore empty. If ANY work remains - a class, a field, a test, a",
  "permission, or a fix to something already there - the answer is SOME. When in",
  "doubt, answer SOME: a wrong NONE ends the run and the work never happens.",
].join("\n");

function splitBlocks(text: string): { id: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const blocks: { id: string; body: string }[] = [];
  let cur: { id: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(REQ_ID);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { id: m[1].toUpperCase(), body: line + "\n" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** Read a design and report whether anything is left to build.
 *
 * "unknown" is a first-class answer and the safe default: a design with no
 * status structure at all must never be read as "nothing to do". Only an
 * explicit, complete statement of satisfaction closes a run. */
export function workRemaining(design: string): WorkReport {
  const text = design ?? "";

  // The explicit line wins - it is a direct answer to exactly this question.
  const explicit = text.match(WORK_REMAINING_LINE);

  const blocks = splitBlocks(text).filter((b) => STATUS_LINE.test(b.body));
  const satisfiedIds: string[] = [];
  const pendingIds: string[] = [];
  for (const b of blocks) {
    const status = b.body.match(STATUS_LINE)?.[1]?.toUpperCase();
    if (status === "ALREADY IMPLEMENTED") satisfiedIds.push(b.id);
    else pendingIds.push(b.id);
  }

  // Per-item statuses are stronger evidence than a single summary line, so when
  // both are present and disagree, the items decide. A design that names
  // outstanding work is not "nothing to do" whatever its last line claims.
  if (blocks.length > 0) {
    const allSatisfied = pendingIds.length === 0;
    if (allSatisfied && explicit && explicit[1].toUpperCase() === "SOME") {
      return {
        verdict: "some",
        total: blocks.length,
        satisfied: satisfiedIds.length,
        pendingIds: [],
        basis:
          "every item is marked ALREADY IMPLEMENTED but the design also states " +
          "WORK-REMAINING: SOME - taking the cautious reading",
      };
    }
    return {
      verdict: allSatisfied ? "none" : "some",
      total: blocks.length,
      satisfied: satisfiedIds.length,
      pendingIds,
      basis: allSatisfied
        ? `all ${blocks.length} item(s) are marked ALREADY IMPLEMENTED`
        : `${pendingIds.length} of ${blocks.length} item(s) still carry work`,
    };
  }

  if (explicit) {
    const none = explicit[1].toUpperCase() === "NONE";
    return {
      verdict: none ? "none" : "some",
      total: 0,
      satisfied: 0,
      pendingIds: [],
      basis: `the design states WORK-REMAINING: ${none ? "NONE" : "SOME"}`,
    };
  }

  return {
    verdict: "unknown",
    total: 0,
    satisfied: 0,
    pendingIds: [],
    basis: "the design states neither per-item statuses nor a WORK-REMAINING line",
  };
}
