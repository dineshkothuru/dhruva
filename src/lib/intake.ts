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
