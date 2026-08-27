/** Model-based intake: "what is this person asking for?"
 *
 * The deterministic classifier in intake.ts stays as the offline fallback, but
 * it is the wrong tool for the job and had the failure to prove it: "Pls design
 * and implement" is 24 characters, classifyChain bails under 25, and the
 * request fell through to a token match on the single word "implement" - so a
 * design-then-build request proposed skipping straight to implementation.
 * Spelling "Please" would have worked. No amount of extra keywords fixes that
 * class of miss, and the classifier structurally cannot read the attached BRD
 * where the real intent lives.
 *
 * So the model reads the request. What it may NOT do is invent work: it picks
 * from the catalog and every id it returns is validated against that catalog
 * before anything is shown. Same shape as a whitelisted intent parser - the
 * model fills a choice, it never authors one. The human still confirms on the
 * proposal card, exactly as before.
 *
 * Split from the route so the prompt and the validator are unit-testable
 * without spawning a CLI. */

export interface IntakeCandidate {
  id: string;
  title: string;
  description?: string;
  custom?: boolean;
}

export interface LlmIntake {
  /** Ordered phases. One entry = a single workflow, several = a chain. */
  workflows: { workflow: string; title: string }[];
  reason: string;
}

/** Chain slots are capped at 5 in the proposal card; match it here. */
const MAX_PHASES = 5;

export function buildIntakePrompt(
  text: string,
  attachments: string[],
  catalog: IntakeCandidate[],
): string {
  const list = catalog
    .map((w) => `- ${w.id} | ${w.title}${w.description ? ` | ${w.description}` : ""}${w.custom ? " | (this team's own workflow)" : ""}`)
    .join("\n");
  const files =
    attachments.length > 0
      ? `\nThe person attached these files to the request: ${attachments.join(", ")}\n` +
        `An attached requirement or specification document is strong evidence this is real ` +
        `delivery work, not a passing question.\n`
      : "";
  return (
    `You route an incoming request to this team's delivery workflows. Answer with JSON only.\n\n` +
    `AVAILABLE WORKFLOWS (id | title | description):\n${list}\n\n` +
    `THE REQUEST:\n${text}\n${files}\n` +
    `Decide which workflows, in order, deliver what is being asked.\n` +
    `- One id when a single workflow covers it.\n` +
    `- Several ids when the request spans phases. "design and implement", ` +
    `"architect it then build it", "end to end" all mean a design workflow FOLLOWED BY an ` +
    `implementation workflow, and both belong in the list, in that order.\n` +
    `- An EMPTY list when this is a question, a greeting, or a request to explain or inspect ` +
    `something rather than deliver it. Answering a question is not a workflow.\n` +
    `Judge the request as written, in any language, however short or informally spelled. ` +
    `Abbreviations ("pls", "req", "impl") carry the same meaning as the full words.\n` +
    `Use ONLY ids from the list above. Never invent an id.\n\n` +
    `Reply with exactly one line of JSON and nothing else:\n` +
    `{"workflows":["<id>","<id>"],"reason":"<one short clause, lowercase, saying what the request asks for>"}`
  );
}

/** Pull the JSON object out of whatever the CLI printed around it - agents
 * narrate, wrap in fences, and print their own banners. Last object wins:
 * the answer comes after any thinking. */
function extractJson(raw: string): unknown {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const candidates = [...fenced, ...[...raw.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0])];
  for (const c of candidates.reverse()) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object" && "workflows" in v) return v;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** Validate the model's answer against the catalog. Unknown ids are DROPPED,
 * never run.
 *
 * null and an empty list mean DIFFERENT things and the caller acts on each
 * differently, so they must not be conflated:
 *   null            - no usable answer (CLI missing, garbage output, or every
 *                     id hallucinated). The caller falls back to the keyword
 *                     classifier rather than assuming the request was chat.
 *   workflows: []   - the model read the request and says it is a question.
 *                     The caller goes straight to chat and does NOT re-run the
 *                     keyword classifier, whose whole problem is over-matching. */
export function parseIntakeReply(raw: string, catalog: IntakeCandidate[]): LlmIntake | null {
  const v = extractJson(raw) as { workflows?: unknown; reason?: unknown } | null;
  if (!v || !Array.isArray(v.workflows)) return null;
  const byId = new Map(catalog.map((w) => [w.id, w]));
  const seen = new Set<string>();
  const workflows: LlmIntake["workflows"] = [];
  for (const id of v.workflows) {
    if (typeof id !== "string") continue;
    const def = byId.get(id.trim());
    if (!def || seen.has(def.id)) continue; // unknown or duplicate phase
    seen.add(def.id);
    workflows.push({ workflow: def.id, title: def.title });
    if (workflows.length >= MAX_PHASES) break;
  }
  // it named workflows and not one of them exists: a bad answer, not a
  // question - fall back rather than silently dropping the request into chat
  if (workflows.length === 0 && v.workflows.length > 0) return null;
  const reason =
    typeof v.reason === "string" && v.reason.trim()
      ? v.reason.trim().replace(/\s+/g, " ").slice(0, 200)
      : "the request matches this workflow";
  return { workflows, reason };
}
