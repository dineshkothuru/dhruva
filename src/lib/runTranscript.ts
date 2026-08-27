import path from "node:path";
import { promises as fs } from "node:fs";
import type { RunState } from "@/lib/workflows/schema";
import { parseOutcome } from "@/lib/outcome";

/** A readable, GREPPABLE transcript beside each run's JSON audit.
 *
 * The JSON is the machine record: every step's output is one escaped string,
 * so a single "line" can be 34,000 characters. Grepping it returns whole
 * steps and saves nothing - measured at 85KB down to 76KB, which defeats the
 * point of searching at all.
 *
 * The same content written as plain text is line-oriented, so a search
 * returns the handful of lines that actually matched. That is the difference
 * between reading 20,000 tokens and reading 50 to answer one question - and
 * it happens to be readable by a person too. */

export function renderTranscript(run: RunState): string {
  const when = new Date(run.createdAt).toISOString();
  const out: string[] = [
    `# ${run.workflowTitle}`,
    ``,
    `run: ${run.runId}`,
    `started: ${when}`,
    `status: ${run.status}`,
    `agent: ${run.agent}${run.model ? ` (${run.model})` : ""}`,
  ];

  if (run.chain && run.chain.length > 1) {
    out.push(
      `chain: ${run.chain.map((c) => c.title).join(" -> ")} (phase ${(run.chainIndex ?? 0) + 1})`,
    );
  }

  const inputs = Object.entries(run.inputs ?? {}).filter(([, v]) => v !== "" && v !== false);
  if (inputs.length > 0) {
    out.push(``, `## What this run was asked to do`, ``);
    for (const [k, v] of inputs) out.push(`${k}: ${String(v)}`);
  }

  if (run.manualSteps?.length) {
    out.push(``, `## Manual steps for a human`, ``);
    for (const m of run.manualSteps) out.push(`- ${m.text} (${m.phase ?? ""} ${m.stepId})`.trim());
  }

  for (const s of run.steps) {
    out.push(``, `## ${s.title}`, ``);
    out.push(`type: ${s.type} | status: ${s.status}${s.model ? ` | model: ${s.model}` : ""}`);
    const stated = s.output ? parseOutcome(s.output) : null;
    if (stated?.summary) out.push(`outcome: ${stated.summary}`);
    if (stated?.produced.length) out.push(`produced: ${stated.produced.join(" | ")}`);
    // the reviewer feedback that sent this step back is part of the WHY
    const revisions = run.revisions?.[s.id];
    if (revisions?.length) {
      out.push(``, `### Feedback given at the gate`, ``);
      for (const r of revisions) out.push(r);
    }
    if (s.output) {
      out.push(``);
      // the actual point: real newlines, so each line greps on its own
      out.push(s.output);
    }
  }

  return out.join("\n");
}

/** Write the transcript beside the JSON. Best-effort: the JSON audit is the
 * source of truth and must never fail because of this. */
export async function writeTranscript(run: RunState): Promise<void> {
  try {
    const dir = path.join(run.root, ".dhruva", "runs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${run.runId}.md`), renderTranscript(run), "utf8");
  } catch {
    /* the machine record already persisted; this is the convenience copy */
  }
}

/** Write the transcript only when it is missing - used to backfill runs that
 * were recorded before transcripts existed. */
export async function ensureTranscript(run: RunState): Promise<void> {
  try {
    const file = path.join(run.root, ".dhruva", "runs", `${run.runId}.md`);
    await fs.access(file);
  } catch {
    await writeTranscript(run);
  }
}
