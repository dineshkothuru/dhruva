/** Task-first intake classifier - deterministic, keyword-based.
 *
 * The user types a requirement/bug in plain language; this proposes the
 * matching workflow. Deliberately NOT an LLM call: the mapping from words to
 * process must be inspectable and stable, and the human confirms the choice
 * anyway (the proposal card). Returns null when the text reads like a plain
 * question - that goes straight to agent chat. */

export interface IntakeProposal {
  workflow: "bug-fix" | "feature-dev" | "solution-design";
  title: string;
  reason: string;
}

const BUG_SIGNALS =
  /\b(bug|error|issue|broken|breaks?|fails?|failing|failure|exception|defect|incorrect|wrong(ly)?|not\s+(working|saving|loading|showing|firing|updating)|doesn'?t\s+(work|save|load|show|fire|update)|crash|stack\s?trace|regression|prod(uction)?\s+issue)\b/i;

const FEATURE_SIGNALS =
  /\b(feature|requirement|user\s+story|story|implement|build|create|add|new\s+(field|object|flow|screen|page|component|button|report|validation|automation)|enhance(ment)?|develop|we\s+(need|want)|as\s+an?\s+\w+\s+i\s+want)\b/i;

const DESIGN_SIGNALS =
  /\b(design|architecture|architect|solution\s+design|erd|data\s+model|hld|lld|technical\s+design|estimate\s+(the|this)|design\s+document|blueprint)\b/i;

const QUESTION_SIGNALS = /^(what|how|why|where|which|who|can you explain|explain|show me|tell me|describe)\b/i;

export function classifyIntake(text: string): IntakeProposal | null {
  const t = text.trim();
  // short texts and questions are chat, not delivery tasks
  if (t.length < 25) return null;
  if (QUESTION_SIGNALS.test(t) && !BUG_SIGNALS.test(t)) return null;

  const bug = BUG_SIGNALS.test(t);
  const feature = FEATURE_SIGNALS.test(t);

  // design intent outranks feature wording ("design the solution for a new…")
  if (DESIGN_SIGNALS.test(t) && !bug) {
    return {
      workflow: "solution-design",
      title: "Solution design",
      reason: "the description asks for a design/architecture rather than direct implementation",
    };
  }
  if (bug) {
    return {
      workflow: "bug-fix",
      title: "Bug fix",
      reason: "the description mentions something failing or behaving incorrectly",
    };
  }
  if (feature) {
    return {
      workflow: "feature-dev",
      title: "Feature development",
      reason: "the description reads like a new requirement or enhancement",
    };
  }
  return null;
}

/** Multi-phase intent ("design and implement", "design then build it"):
 * proposes a workflow CHAIN - design first, implementation auto-started from
 * the design's TDD + build plan. Same rules as classifyIntake: deterministic,
 * and the human confirms (and can reshape) the chain before anything runs. */
export interface ChainProposal {
  phases: { workflow: string; title: string }[];
  reason: string;
}

const BUILD_VERBS = /\b(implement|build|develop|deliver|code)\b/i;
const CHAIN_GLUE =
  /(\band\b|&|\bthen\b|\bafter\s+that\b|\bfollowed\s+by\b|\bend[-\s]?to[-\s]?end\b|\bfull\s+(cycle|delivery)\b|\be2e\b)/i;

export function classifyChain(text: string): ChainProposal | null {
  const t = text.trim();
  if (t.length < 25) return null;
  if (BUG_SIGNALS.test(t)) return null; // bug talk goes to the single-workflow intake
  if (!DESIGN_SIGNALS.test(t) || !BUILD_VERBS.test(t) || !CHAIN_GLUE.test(t)) return null;
  return {
    phases: [
      { workflow: "solution-design", title: "Solution design" },
      { workflow: "implement-tdd", title: "Implement from TDD" },
    ],
    reason:
      "the description asks for a design AND its implementation - the design's TDD and build plan feed straight into the implement workflow",
  };
}

/** Catalog-aware suggestion: when the prompt speaks in a workflow's own
 * title words (standard OR custom), propose THAT one - the team's vocabulary
 * outranks the generic signals. Deterministic token overlap, no LLM. */
const STOP = new Set([
  "the", "a", "an", "and", "for", "from", "with", "this", "that", "into", "then", "them", "your",
]);

export function matchCatalog(
  text: string,
  catalog: { id: string; title: string; description?: string; custom?: boolean }[] | null,
): { workflow: string; title: string; reason: string } | null {
  if (!catalog || text.trim().length < 12) return null;
  const t = text.toLowerCase();
  let best: { id: string; title: string; custom?: boolean; score: number } | null = null;
  for (const w of catalog) {
    const tokens = [
      ...new Set(
        `${w.title} ${w.id.replace(/-/g, " ")}`
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((x) => x.length >= 4 && !STOP.has(x)),
      ),
    ];
    if (tokens.length === 0) continue;
    const hits = tokens.filter((x) => t.includes(x)).length;
    const fullTitle = w.title.length >= 6 && t.includes(w.title.toLowerCase());
    if (!fullTitle && hits < Math.min(2, tokens.length)) continue;
    // the user's own custom workflows win ties against shipped ones
    const score = (fullTitle ? tokens.length + 2 : hits) + (w.custom ? 0.5 : 0);
    if (!best || score > best.score) best = { id: w.id, title: w.title, custom: w.custom, score };
  }
  if (!best) return null;
  return {
    workflow: best.id,
    title: best.title,
    reason: `your description matches the "${best.title}" workflow${best.custom ? " (your custom workflow)" : ""}`,
  };
}
