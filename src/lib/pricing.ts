/** Informational API-rate cost estimation.
 *
 * The agent CLIs run on the user's subscription (Copilot seat / Claude plan /
 * ChatGPT), so nothing here is billed — this answers "what WOULD this task
 * cost at public API rates". Tokens are estimated at ~4 chars/token from the
 * prompt we sent and the output we saw (the agent's internal context reads
 * are not visible to the harness), so treat every number as a floor estimate.
 *
 * Rates are USD per 1M tokens — edit here as providers change pricing. */

export interface Usage {
  inTokens: number;
  outTokens: number;
  costUsd: number;
  estimated: true;
}

const RATES: { match: RegExp; inPerM: number; outPerM: number }[] = [
  { match: /fable|opus/i, inPerM: 15, outPerM: 75 },
  { match: /sonnet/i, inPerM: 3, outPerM: 15 },
  { match: /haiku/i, inPerM: 1, outPerM: 5 },
  { match: /gpt-5.*mini/i, inPerM: 0.25, outPerM: 2 },
  { match: /gpt/i, inPerM: 1.25, outPerM: 10 },
  { match: /gemini/i, inPerM: 1.25, outPerM: 10 },
];

/** Fallback tier per agent when the model id is unknown/default. */
const AGENT_DEFAULT: Record<string, { inPerM: number; outPerM: number }> = {
  copilot: { inPerM: 3, outPerM: 15 }, // Sonnet-tier default
  claude: { inPerM: 3, outPerM: 15 },
  codex: { inPerM: 1.25, outPerM: 10 },
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateUsage(
  agent: string,
  model: string | undefined,
  promptText: string,
  outputText: string,
): Usage {
  const rate =
    (model && RATES.find((r) => r.match.test(model))) ||
    AGENT_DEFAULT[agent] ||
    AGENT_DEFAULT.claude;
  const inTokens = estimateTokens(promptText);
  const outTokens = estimateTokens(outputText);
  const costUsd =
    (inTokens / 1_000_000) * rate.inPerM + (outTokens / 1_000_000) * rate.outPerM;
  return { inTokens, outTokens, costUsd, estimated: true };
}

export function formatUsage(u: Usage): string {
  const cost = u.costUsd < 0.01 ? `$${u.costUsd.toFixed(4)}` : `$${u.costUsd.toFixed(2)}`;
  return `~${u.inTokens.toLocaleString()} in / ${u.outTokens.toLocaleString()} out tokens · ${cost} (est. at API rates)`;
}
