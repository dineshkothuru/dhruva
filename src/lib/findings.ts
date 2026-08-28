/** Deterministic parser for reviewer findings - the "F1 (critical) [refs:...]"
 * blocks every critic emits (legacy "F1: title (critical)" also supported).
 * Pure text parsing, zero tokens; shared by the step-trace renderer and the
 * gate's findings panel so findings look the same everywhere. */

export interface Finding {
  id: string;
  severity: "critical" | "important" | "nit";
  refs: string[];
  title: string;
  where: string;
  problem: string;
  fix: string;
}

const strip = (s: string) => s.replace(/\*+/g, "").trim();

/** The findings contract, in ONE place next to the parser that reads it.
 *
 * This text used to be written out longhand in every review step - five copies
 * of the shape `parseFindings` expects, free to drift apart one edit at a time.
 * The outcome block had exactly that problem and was fixed the same way: the
 * engine appends the constant, and a test round-trips it through the parser.
 *
 * A step opts in with `emits: "findings"`. */
export const FINDINGS_INSTRUCTION =
  `

Report each finding in this exact shape (it is machine-parsed - keep the ` +
  `labels verbatim):
` +
  `F<n> (critical | important | nit) [refs: <the REQ-/UX-/task ids this finding ` +
  `concerns, comma-separated; '-' only for a truly global finding>]: <short title>
` +
  `  Where: <file / component / section>
` +
  `  Problem: <what is wrong>
` +
  `  Fix: <the concrete change to make>
` +
  `critical = would break in production or violates a blocking standard; ` +
  `important = should be fixed before deploy; nit = style/polish, never blocks.
` +
  `Number findings sequentially from F1. Reference requirements inline as REQ-xxx, ` +
  `NEVER as "### REQ-" headings - those are parsed as design blocks.
` +
  `Then end with exactly one line:
` +
  `VERDICT: APPROVED - or - VERDICT: BLOCKED, followed by the critical/important ` +
  `finding ids. nit-only findings never block.`;

/** The coverage contract, read by the engine's autoRevise trigger. */
export const COVERAGE_INSTRUCTION =
  `

End with exactly one line, machine-parsed, labels verbatim:
` +
  `COVERAGE: COMPLETE - or - COVERAGE: INCOMPLETE - items <ids>`;

/** Extract findings and the text before them. `trailing` carries verdict/exit
 * lines that follow the last finding (rendered separately by callers). */
export function parseFindings(text: string): {
  before: string;
  findings: Finding[];
  trailing: string;
} {
  const first = text.search(/^\*{0,2}F\d+[\s:(]/m);
  if (first === -1) return { before: text, findings: [], trailing: "" };
  const before = text.slice(0, first);
  const rest = text.slice(first);
  const parts = rest.split(/(?=^\*{0,2}F\d+[\s:(])/m).filter((p) => p.trim());
  const findings: Finding[] = [];
  let trailing = "";
  for (const p of parts) {
    // new format: F1 (critical) [refs: REQ-007]: title
    const neu = p.match(
      /^\*{0,2}(F\d+)\s*\((critical|important|nit)\)\s*(?:\[refs:\s*([^\]]*)\])?\s*:\s*([^\n]*)/,
    );
    // legacy: F1: title (critical)
    const old = neu ? null : p.match(/^\*{0,2}(F\d+):\s*(.{0,300}?)\s*\((critical|important|nit)\)/s);
    if (!neu && !old) {
      trailing += p;
      continue;
    }
    const body = p;
    const grab = (label: string) =>
      strip(
        body.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:Where|Problem|Fix):|\\n\\s*\\*{0,2}F\\d+[\\s:(]|\\nVERDICT:|\\n\\[(?:exit|engine|agent error)|$)`))?.[1] ?? "",
      );
    // whatever follows the Fix that is verdict/exit/engine noise goes to trailing
    const tail = body.match(/\n(VERDICT:[\s\S]*|\[exit[\s\S]*)/);
    if (tail) trailing += tail[1] + "\n";
    findings.push({
      id: neu ? neu[1] : old![1],
      severity: (neu ? neu[2] : old![3]) as Finding["severity"],
      refs: [
        ...new Set(neu?.[3] ? (neu[3].match(/(?:REQ|UX|T|AC)-\d+/g) ?? []) : (body.match(/REQ-\d+/g) ?? [])),
      ],
      title: strip(neu ? neu[4] : old![2]).replace(/\s*\(critical\)|\s*\(important\)|\s*\(nit\)/g, ""),
      where: grab("Where"),
      problem: grab("Problem"),
      fix: grab("Fix"),
    });
  }
  return { before, findings, trailing };
}

/** Tail kept when a reviewer's output carries no parseable findings: the end
 * of the transcript, where a verdict or a conclusion sits. */
const TAIL_CHARS = 12_000;

/** What a review step hands back to the step it is reworking.
 *
 * The bug this exists to prevent: a step's `output` is the RAW CLI transcript.
 * It opens with the engine's own "[engine] model requested" banner, continues
 * through dozens of tool-trace lines, and the findings land at the END.
 * Forwarding the FIRST 4,000 characters therefore forwarded pure noise.
 * Measured on a real run: the reviewer wrote 25,558 characters and the first
 * finding began at 9,936, so the reworked step was ordered to "follow every
 * point" of a directory listing, changed nothing, and was blocked again.
 *
 * Raising that number would not have been enough on its own - a head-anchored
 * cap reproduces the same failure the moment the tool trace grows. So there is
 * NO cap on the findings: every one goes back whole, with its Where / Problem /
 * Fix intact. The only thing dropped is the tool trace, and a tool trace is not
 * information. When nothing parses (a reviewer on a different contract, e.g.
 * "COVERAGE: INCOMPLETE"), fall back to the TAIL rather than the head. */
export function reviewFeedback(output: string): string {
  const { findings } = parseFindings(output);
  if (findings.length === 0) return output.slice(-TAIL_CHARS);
  const verdict = output.match(/VERDICT:[^\n]*/i)?.[0] ?? "";
  const body = findings
    .map((f) =>
      [
        `${f.id} (${f.severity})${f.refs.length ? ` [refs: ${f.refs.join(", ")}]` : ""}: ${f.title}`,
        f.where ? `  Where: ${f.where}` : "",
        f.problem ? `  Problem: ${f.problem}` : "",
        f.fix ? `  Fix: ${f.fix}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return [verdict, body].filter(Boolean).join("\n\n");
}
