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
      ].slice(0, 4),
      title: strip(neu ? neu[4] : old![2]).replace(/\s*\(critical\)|\s*\(important\)|\s*\(nit\)/g, ""),
      where: grab("Where"),
      problem: grab("Problem"),
      fix: grab("Fix"),
    });
  }
  return { before, findings, trailing };
}
