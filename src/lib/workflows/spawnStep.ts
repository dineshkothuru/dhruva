import { spawn } from "node:child_process";
import type { RunState, StepState } from "./schema";
import { activeChildren, persist, persistSoon } from "./runStore";

/** The process layer: one function that runs a CLI child and streams its
 * output onto a step, with the budget, kill, and capture semantics the
 * engine's audit trail depends on. Extracted so the process handling can be
 * reasoned about apart from the orchestration that decides WHAT to run. */

/** Runaway backstop, NOT a content budget. The CLI has already generated and
 * billed every token by the time this applies, so it cannot make a step terser
 * (that is a sentence in the prompt); all it decides is what the harness keeps
 * in memory and writes to the run json. Set far above anything real - the
 * largest step output measured across real runs is 40,728 characters - so it
 * only ever trips on a process printing without end. */
export const STEP_OUTPUT_CAP = 5_000_000;
export const STEP_TIMEOUT_MS = 15 * 60 * 1000;

export function makeClaudeTraceTransform(step: StepState): (chunk: string) => string {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // keep the trailing partial line
    let out = "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const ev = JSON.parse(t);
        // the init event carries the model the CLI ACTUALLY runs - exact even
        // when we requested nothing (CLI default); overwrite the requested id
        if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") {
          step.model = ev.model;
          out += `[agent] model in use: ${ev.model}\n`;
        } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === "text" && block.text) out += block.text + "\n";
            else if (block.type === "tool_use") {
              const arg = JSON.stringify(block.input ?? {}).slice(0, 160);
              out += `  ⚙ ${block.name} ${arg}\n`;
            }
          }
        } else if (ev.type === "result") {
          if (ev.usage) {
            step.usage = {
              inTokens:
                (ev.usage.input_tokens ?? 0) +
                (ev.usage.cache_read_input_tokens ?? 0) +
                (ev.usage.cache_creation_input_tokens ?? 0),
              outTokens: ev.usage.output_tokens ?? 0,
              costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0,
              estimated: false,
            };
          }
          if (ev.is_error && ev.result) out += `\n[agent error] ${String(ev.result).slice(0, 500)}\n`;
        }
      } catch {
        /* partial or non-JSON line - ignore */
      }
    }
    return out;
  };
}

export function spawnToStep(
  run: RunState,
  step: StepState,
  bin: string,
  args: string[],
  stdin?: string,
  transform?: (chunk: string) => string,
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<boolean> {
  // an abort can land between the awaits that precede a spawn (standards
  // loading, prompt-file writes, task-loop iterations) - never launch a fresh
  // process for an aborted run: nothing could kill it afterwards
  if ((run.status as string) === "aborted") {
    step.output += "\n[engine] aborted before the step's process started";
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    // One settle point. A timed-out step must end at its budget even if the
    // process ignores the kill and keeps streaming, and the child's later
    // "close" must not then append an exit line to a step already finished.
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(run.runId);
      void persist(run);
      resolve(ok);
    };
    const child = spawn(bin, args, {
      cwd: run.root,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CI: "true",
        // cmd.exe (shell:true) searches the current directory before PATH on
        // Windows, and cwd is the attached (untrusted) project - a planted
        // sf.cmd/copilot.cmd would run. Remove cwd from that search.
        NoDefaultCurrentDirectoryInExePath: "1",
      },
    });
    activeChildren.set(run.runId, child);
    const timer = setTimeout(() => {
      step.output +=
        `\n[engine] step timed out after ${Math.round(timeoutMs / 60_000)} minutes - ` +
        `giving up on it. Anything the agent writes from here is NOT captured.`;
      // shell:true means child is cmd.exe - kill the whole tree or the real
      // CLI survives as an orphan still editing the project
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
      child.kill();
      // Settle NOW rather than waiting for the child's "close". The kill does
      // not always take: on a real run a 30-minute task carried on for 72,
      // because this handler only asked the process to die and then went on
      // waiting for it. A budget that a failed kill can extend is not a budget.
      settle(false);
    }, timeoutMs);
    // EPIPE when the CLI exits before draining (e.g. expired login) must not
    // crash the server process
    child.stdin.on("error", () => {});
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    // Past the backstop the step is left INCOMPLETE and says so, once. The old
    // behaviour kept the head plus a 10k tail and spliced them together, which
    // silently removed the middle - the same shape of bug as slicing a review
    // to its first 4,000 characters, and invisible to everything downstream.
    let overflowed = false;
    const push = (chunk: Buffer | string) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, "");
      const rendered = transform ? transform(text) : text;
      if (!rendered) return persistSoon(run);
      if (step.output.length < STEP_OUTPUT_CAP) {
        step.output += rendered;
      } else if (!overflowed) {
        overflowed = true;
        step.output +=
          `\n[engine] RUNAWAY OUTPUT: this step passed ${STEP_OUTPUT_CAP / 1_000_000}M characters ` +
          `and the rest was not captured. Treat this step's result as INCOMPLETE - it is a ` +
          `backstop against a process printing without end, not a size budget.\n`;
      }
      persistSoon(run);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => {
      clearTimeout(timer);
      activeChildren.delete(run.runId);
      step.output += `\n[engine] could not start ${bin}: ${e.message}`;
      settle(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // a step already settled by the timeout must not gain a late exit line
      if (settled) return;
      // flush the transform's trailing partial line (a final stream-json
      // result event without a newline carries the exact usage)
      if (transform) push("\n");
      step.output += `\n[exit ${code}]`;
      settle(code === 0);
    });
  });
}
