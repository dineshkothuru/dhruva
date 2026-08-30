/** The step-outcome contract.
 *
 * Everything else in the trace is reverse-engineered from free prose: count
 * the "Read" lines, count the REQ blocks, hope the model wrote VERDICT the
 * way we expect. That works, but it is guesswork, and it degrades whenever a
 * model phrases things differently.
 *
 * So every agent step is now ASKED to end with a small fixed block. When it
 * is present we know exactly what the step produced, in the agent's own
 * words. When it is absent - an older run, a custom workflow that has not
 * adopted it, a step that failed early - callers fall back to the existing
 * heuristics, so nothing regresses.
 *
 * Cost is a few dozen output tokens per step. Parsing stays free. */

export const OUTCOME_START = "=== STEP OUTCOME ===";
export const OUTCOME_END = "=== END OUTCOME ===";

/** Appended to every agent step prompt. Kept short on purpose: a long
 * template competes with the actual task for the model's attention. */
export const OUTCOME_INSTRUCTION =
  `\n\nFINISH WITH THIS BLOCK, exactly once, as the very last thing you write. ` +
  `It is parsed by the tool, so keep the markers and labels verbatim:\n` +
  `${OUTCOME_START}\n` +
  `SUMMARY: one plain sentence a colleague could read without context\n` +
  `PRODUCED: what now exists that did not before, as short items separated by | ` +
  `(write "nothing" if the step only read or analysed)\n` +
  `CONFIDENCE: high | medium | low - and if not high, the reason in a few words\n` +
  `${OUTCOME_END}`;

export interface StepOutcome {
  summary: string;
  produced: string[];
  confidence: "high" | "medium" | "low" | "";
  confidenceNote: string;
}

/** Bound a field for the summary tile without lying about it.
 *
 * These were hard `slice()` calls, so a step that wrote a long sentence had it
 * cut mid-word - "...Feature 4 is largely a thin CRUD scaffold requiring a" -
 * which reads as a broken renderer rather than a summary that ran long. Cut at
 * a word boundary and say it was cut; the whole block is still in the raw
 * trace either way. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** Pull the block out of a step's output. Returns null when absent. */
export function parseOutcome(output: string): StepOutcome | null {
  const start = output.lastIndexOf(OUTCOME_START);
  if (start === -1) return null;
  const endIdx = output.indexOf(OUTCOME_END, start);
  const body = output.slice(start + OUTCOME_START.length, endIdx === -1 ? undefined : endIdx);

  const field = (label: string) =>
    body.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";

  const summary = clip(field("SUMMARY"), 700);
  const producedRaw = field("PRODUCED");
  const produced =
    !producedRaw || /^(nothing|none|n\/a)\b/i.test(producedRaw)
      ? []
      : producedRaw
          .split("|")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 8)
          .map((x) => clip(x, 160));

  const confRaw = field("CONFIDENCE");
  const level = confRaw.match(/\b(high|medium|low)\b/i)?.[1]?.toLowerCase() ?? "";
  const note = confRaw.replace(/^\s*(high|medium|low)\b[\s:,-]*/i, "").trim();

  if (!summary && produced.length === 0 && !level) return null;
  return {
    summary,
    produced,
    confidence: level as StepOutcome["confidence"],
    confidenceNote: clip(note, 400),
  };
}

/** The block is machine plumbing - strip it before showing the prose. */
export function stripOutcome(output: string): string {
  const start = output.lastIndexOf(OUTCOME_START);
  if (start === -1) return output;
  const endIdx = output.indexOf(OUTCOME_END, start);
  const after = endIdx === -1 ? "" : output.slice(endIdx + OUTCOME_END.length);
  return (output.slice(0, start) + after).trimEnd();
}
