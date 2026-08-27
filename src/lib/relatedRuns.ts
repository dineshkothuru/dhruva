import type { RunState } from "@/lib/workflows/schema";

/** Has this been done already?
 *
 * Ask for "a lead scoring engine" a week after a Solution design run covered
 * exactly that, and chat would happily start a second one. Nothing pointed at
 * the work that already existed.
 *
 * Deterministic token overlap against each run's recorded inputs - the same
 * approach as the workflow catalog match, and for the same reason: the rule
 * has to be inspectable and cost nothing. */

const STOP = new Set([
  "the", "a", "an", "and", "or", "for", "from", "with", "this", "that", "into", "then", "them",
  "your", "our", "their", "please", "need", "want", "should", "would", "could", "will", "can",
  "make", "add", "new", "some", "all", "any", "not", "are", "was", "were", "has", "have", "had",
  "its", "it's", "you", "how", "what", "when", "which", "who", "why", "use", "using", "get",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

export interface RelatedRun {
  runId: string;
  title: string;
  status: string;
  createdAt: number;
  /** the words that matched, so the suggestion can justify itself */
  shared: string[];
}

/** Everything a run recorded about what it was asked to do. */
function runText(r: RunState): string {
  const inputs = Object.values(r.inputs ?? {})
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return `${r.workflowTitle} ${inputs}`;
}

/** Runs whose request overlaps this one, best first. Deliberately strict:
 * a weak suggestion is worse than none, because it trains people to ignore
 * the panel. */
export function findRelatedRuns(text: string, runs: RunState[], limit = 3): RelatedRun[] {
  const want = tokens(text);
  if (want.size < 2) return [];

  const scored = runs
    .map((r) => {
      const have = tokens(runText(r));
      const shared = [...want].filter((w) => have.has(w));
      return { r, shared };
    })
    // at least 3 shared terms, or half the request matched for short asks
    .filter(({ shared }) => shared.length >= Math.min(3, Math.ceil(want.size / 2)))
    .sort((a, b) => b.shared.length - a.shared.length || b.r.createdAt - a.r.createdAt);

  return scored.slice(0, limit).map(({ r, shared }) => ({
    runId: r.runId,
    title: r.workflowTitle,
    status: r.status,
    createdAt: r.createdAt,
    shared: shared.slice(0, 6),
  }));
}
