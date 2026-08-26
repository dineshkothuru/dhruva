import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { AgentId } from "@/lib/agents";
import { AGENTS } from "@/lib/agents";
import { takeSnapshot, changesSince, headCommit, commitRunResult } from "@/lib/snapshot";
import { STANDARDS_PROMPT, checkStandards } from "@/lib/standards";
import { persona, standardsFor } from "@/lib/standardsLibrary";
import { estimateUsage } from "@/lib/pricing";
import { loadTasks, saveTasks, pendingInOrder, reopenFromFindings } from "@/lib/workflows/tasks";
import type { GateDecision, RunState, StepDef, StepState, WorkflowDef } from "./schema";
import { ROLE_TIER } from "./schema";

/** Deterministic workflow runner. Runs live in this server process (a local
 * single-user tool); every state change is persisted to
 * <project>/.sfharness/runs/<runId>.json — the audit trail. */

const runs = new Map<string, RunState>();
const gateWaiters = new Map<string, (decision: GateDecision) => void>(); // key: runId
// the live child process of each run's current step — so an abort can kill it
const activeChildren = new Map<string, ReturnType<typeof spawn>>();
const STEP_OUTPUT_CAP = 60_000;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

export function getRun(runId: string): RunState | undefined {
  return runs.get(runId);
}

/** Is a run currently active (running or parked at a gate) for this project?
 * The chat route checks this before re-baselining the shared snapshot store. */
export function hasActiveRun(root: string): boolean {
  for (const r of runs.values()) {
    if (r.root === root && (r.status === "running" || r.status === "waiting_gate")) return true;
  }
  return false;
}

/** Live runs for this project waiting on a human gate (in-memory only —
 * cheap enough to poll for the tab-bar indicator). */
export function pendingGateCount(root: string): number {
  let n = 0;
  for (const r of runs.values()) {
    if (r.root === root && r.status === "waiting_gate") n++;
  }
  return n;
}

/** Recent runs for a project: in-memory (live) runs merged with the audit
 * files on disk, so history survives server restarts. A disk run still
 * marked running belongs to a dead server process → shown as aborted. */
export async function listRuns(root: string): Promise<RunState[]> {
  const byId = new Map<string, RunState>();
  const dir = path.join(root, ".sfharness", "runs");
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as RunState;
        if (!r.runId || !Array.isArray(r.steps)) continue;
        if (r.status === "running" || r.status === "waiting_gate") r.status = "aborted";
        byId.set(r.runId, r);
      } catch {
        /* corrupt audit file — skip */
      }
    }
  } catch {
    /* no runs dir yet */
  }
  for (const r of runs.values()) {
    if (r.root === root) byId.set(r.runId, r); // live state wins over disk
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

/** User-requested stop of a live run: resolves a waiting gate as an abort,
 * or kills the running step's process tree. The executor loop sees the
 * aborted status and skips every remaining step. */
export function abortRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || (run.status !== "running" && run.status !== "waiting_gate")) return false;
  run.status = "aborted";
  if (resolveGate(runId, { action: "abort" })) return true; // parked at a gate
  const step = run.steps.find((s) => s.status === "running");
  if (step) step.output += "\n[engine] aborted by user";
  const child = activeChildren.get(runId);
  if (child?.pid) {
    // shell:true means the child is cmd.exe — kill the whole tree
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
    child.kill();
  }
  void persist(run);
  return true;
}

export function resolveGate(runId: string, decision: GateDecision): boolean {
  const waiter = gateWaiters.get(runId);
  if (!waiter) return false;
  gateWaiters.delete(runId);
  waiter(decision);
  return true;
}

export function startRun(
  root: string,
  def: WorkflowDef,
  inputs: Record<string, string | boolean>,
  agent: AgentId,
  model?: string,
  roleModels?: RunState["roleModels"],
): RunState | null {
  const run: RunState = {
    runId: randomUUID().slice(0, 12),
    workflowId: def.id,
    workflowTitle: def.title,
    root,
    createdAt: Date.now(),
    status: "running",
    agent,
    model,
    roleModels,
    inputs,
    steps: def.steps.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      status: "pending",
      output: "",
    })),
  };
  runs.set(run.runId, run);
  void execute(run, def); // fire and forget; UI polls state
  return run;
}

const MAX_REVISIONS_PER_GATE = 5;

async function execute(run: RunState, def: WorkflowDef) {
  await executeSteps(run, def);
  // Pin the end state (without moving HEAD) so this run stays diffable after
  // later runs re-baseline — done for every terminal status incl. aborted.
  run.endCommit = (await commitRunResult(run.root, run.runId)) ?? undefined;
  await persist(run);
}

async function executeSteps(run: RunState, def: WorkflowDef) {
  for (let i = 0; i < def.steps.length; i++) {
    const stepDef = def.steps[i];
    const step = run.steps.find((s) => s.id === stepDef.id)!;
    if ((run.status as string) === "aborted") {
      step.status = "skipped";
      continue;
    }
    if (stepDef.onlyIf && !run.inputs[stepDef.onlyIf]) {
      step.status = "skipped";
      await persist(run);
      continue;
    }

    // Gates run here (not in runStep) so a "revise" decision can re-run the
    // steps this gate reviews — everything back to the nearest agent step —
    // with the reviewer's feedback injected, then gate again.
    if (stepDef.type === "gate") {
      let revisions = 0;
      let notice = ""; // survives re-render (e.g. "revision not possible")
      for (;;) {
        step.status = "waiting_gate";
        step.startedAt ??= Date.now();
        step.output = template(stepDef.message ?? "Proceed?", run) + notice;
        run.status = "waiting_gate";
        await persist(run);
        const decision = await new Promise<GateDecision>((resolve) => {
          gateWaiters.set(run.runId, resolve);
        });
        if (decision.action === "approve") {
          run.status = "running";
          step.output += "\n→ approved";
          step.status = "done";
          step.endedAt = Date.now();
          await persist(run);
          break;
        }
        if (decision.action === "abort" || !decision.feedback?.trim()) {
          run.status = "aborted";
          step.output += "\n→ aborted by user";
          step.status = "failed";
          step.endedAt = Date.now();
          await persist(run);
          return;
        }
        // revise: replay from the gate's declared target (or the nearest
        // preceding agent step) with the feedback injected
        const from = stepDef.reviseTarget
          ? def.steps.findIndex((s) => s.id === stepDef.reviseTarget)
          : nearestAgentIndex(def, i);
        if (from < 0 || from >= i || ++revisions > MAX_REVISIONS_PER_GATE) {
          notice =
            revisions > MAX_REVISIONS_PER_GATE
              ? "\n\n→ revision limit reached — approve or abort"
              : "\n\n→ revision is not possible at this gate (no earlier agent step) — approve or abort";
          continue;
        }
        const targetId = def.steps[from].id;
        run.revisions ??= {};
        (run.revisions[targetId] ??= []).push(decision.feedback.trim());
        step.output += `\n→ revision requested: ${decision.feedback.trim().slice(0, 300)}`;
        run.status = "running";
        await persist(run);
        if (!(await replayRange(run, def, from, i))) return;
        // loop: gate again on the revised state
      }
      continue;
    }

    step.status = "running";
    step.startedAt = Date.now();
    await persist(run);
    try {
      const ok = await runStep(run, stepDef, step);
      step.endedAt = Date.now();
      if (!ok) {
        if (step.status === "running") step.status = "failed";
        if ((run.status as string) !== "aborted") run.status = "failed";
        await persist(run);
        return;
      }
      if (step.status === "running") step.status = "done";
      // Bounded self-healing (before the human gate): a review step whose
      // verdict matches its trigger auto-revises its target with the findings
      // as feedback, then re-runs everything up to and including itself. The
      // following human gate always still fires — this pre-cleans what the
      // human reviews, it never replaces them.
      if (stepDef.type === "agent" && stepDef.autoRevise) {
        const ar = stepDef.autoRevise;
        let re: RegExp | null = null;
        try {
          re = new RegExp(ar.trigger.slice(0, 200), "i");
        } catch {
          re = null;
        }
        const from = def.steps.findIndex((s) => s.id === ar.target);
        const max = Math.min(Math.max(ar.maxRounds ?? 1, 1), 3);
        for (
          let round = 1;
          re && from >= 0 && from < i && round <= max && re.test(step.output);
          round++
        ) {
          // reviewer "REOPEN T-n: comment" lines reopen those tasks so the
          // implement task-loop reworks only what the reviewer flagged
          if (stepDef.tasksFile) {
            const rel = template(stepDef.tasksFile, run).replace(/\\/g, "/");
            const reopened = await reopenFromFindings(run.root, rel, step.output);
            if (reopened.length > 0) {
              step.output += `\n[engine] reopened task(s): ${reopened.join(", ")}`;
            }
          }
          const targetId = def.steps[from].id;
          run.revisions ??= {};
          (run.revisions[targetId] ??= []).push(
            `[auto-revise round ${round} — findings from ${stepDef.id}]\n${step.output.slice(0, 4000)}`,
          );
          step.output += `\n\n[engine] auto-revise round ${round}/${max}: replaying ${targetId}`;
          await persist(run);
          if (!(await replayRange(run, def, from, i + 1))) return;
        }
      }
    } catch (e) {
      step.status = "failed";
      step.output += `\n[engine] ${String(e)}`;
      step.endedAt = Date.now();
      run.status = "failed";
      await persist(run);
      return;
    }
    await persist(run);
  }
  if ((run.status as string) !== "aborted") run.status = "done";
  await persist(run);
}

/** Re-run steps [from, to) against the current run state (revision feedback
 * already recorded). Gates inside the range were already approved and are
 * never replayed. Returns false when a replayed step fails (run marked). */
async function replayRange(
  run: RunState,
  def: WorkflowDef,
  from: number,
  to: number,
): Promise<boolean> {
  for (let k = from; k < to; k++) {
    const replayDef = def.steps[k];
    if (replayDef.type === "gate") continue;
    if (replayDef.onlyIf && !run.inputs[replayDef.onlyIf]) continue;
    const replayStep = run.steps.find((s) => s.id === replayDef.id)!;
    replayStep.output = "";
    replayStep.usage = undefined;
    replayStep.status = "running";
    replayStep.startedAt = Date.now();
    await persist(run);
    const ok = await runStep(run, replayDef, replayStep);
    replayStep.endedAt = Date.now();
    if (!ok) {
      if (replayStep.status === "running") replayStep.status = "failed";
      if ((run.status as string) !== "aborted") run.status = "failed";
      await persist(run);
      return false;
    }
    if (replayStep.status === "running") replayStep.status = "done";
    await persist(run);
  }
  return true;
}

/** The nearest agent step before index i — the step a gate's revision re-runs. */
function nearestAgentIndex(def: WorkflowDef, i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (def.steps[j].type === "agent") return j;
  }
  return -1;
}

async function runStep(run: RunState, def: StepDef, step: StepState): Promise<boolean> {
  switch (def.type) {
    case "snapshot": {
      const ok = await takeSnapshot(run.root);
      if (ok) run.baseCommit = (await headCommit(run.root)) ?? undefined;
      step.output = ok ? "baseline snapshot taken" : "snapshot unavailable (git missing?)";
      return ok;
    }
    case "changes": {
      const changes = await changesSince(run.root);
      if (changes === null) {
        step.output = "snapshot store unavailable";
        return false;
      }
      run.changes = changes;
      step.output = changes.length
        ? changes.map((c) => `${c.status.padEnd(8)} ${c.file}`).join("\n")
        : "no files changed";
      return true;
    }
    case "gate": {
      // gates are handled by the executor (revise loop); reaching here is a bug
      step.output = "[engine] gate reached runStep — executor should handle gates";
      return false;
    }
    case "agent": {
      const agentDef = AGENTS[run.agent];
      // Ground the agent explicitly in the attached folder (prompt clarity +
      // audit-log readability; the cwd already enforces it technically).
      // Standards are injected by the ENGINE — same rules, verbatim, for
      // every agent vendor; never dependent on vendor file conventions.
      // Scope: modules whose applyTo matches the files this run touches
      // (affected from the investigation, or changed files); baseline +
      // unscoped modules always. Distilled block is the fallback if the
      // standards library is missing from the install.
      const scopeFiles = [
        ...(run.affected ?? []),
        ...(run.changes ?? []).map((c) => c.file),
      ];
      const rules = (await standardsFor(scopeFiles).catch(() => "")) || STANDARDS_PROMPT;
      const role = def.persona ? await persona(def.persona).catch(() => "") : "";
      // Reviewer feedback from gates: mandatory, most recent last.
      const feedback = run.revisions?.[def.id];
      const feedbackBlock =
        feedback && feedback.length > 0
          ? `\n\nREVIEWER INSTRUCTIONS (mandatory — this is a revision of your earlier output; follow every point):\n${feedback
              .map((f, n) => `${n + 1}. ${f}`)
              .join("\n")}`
          : "";
      const prompt =
        `You are working inside the Salesforce DX project at ${run.root} ` +
        `(your current working directory). Only read and modify files in this project.\n` +
        `CRITICAL: when the task references a document, attachment, requirement file, or design ` +
        `file, read it COMPLETELY before acting — if your file-reading tool returns only part of ` +
        `it (e.g. the first 2000 lines), keep reading with offsets until the end of the file. ` +
        `Never analyse, design, or implement from a partially read document; if a referenced ` +
        `document cannot be fully read, say so explicitly instead of proceeding.\n\n` +
        (role ? `${role}\n\n` : "") +
        `MANDATORY TEAM STANDARDS:\n${rules}\n\n` +
        template(def.prompt ?? "", run) +
        feedbackBlock;
      // Model resolution, most specific wins:
      // 1. the user's per-ROLE model for this run (the Models-by-role setting)
      // 2. the role's tier through the agent's shipped tiers map
      // 3. the run's selected model / CLI default.
      const roleModel = def.role ? run.roleModels?.[def.role] : undefined;
      const tierModel = def.role ? agentDef.tiers[ROLE_TIER[def.role]] : undefined;
      const stepModel = roleModel || tierModel || run.model;
      step.model = stepModel || "default";
      // claude: stream-json gives a LIVE trace (tool uses + text as produced)
      // and exact token usage in the final event; others stream plain text.
      const streamJson = run.agent === "claude";
      const spawnAgent = async (fullPrompt: string, promptTag: string): Promise<boolean> => {
        let p = fullPrompt;
        // Inline-prompt agents (copilot) hit cmd.exe's ~8k command-line limit —
        // the standards alone exceed it and the task would be truncated away.
        // Write the full prompt to a harness file and pass a short pointer.
        if (run.agent === "copilot") {
          const rel = `.sfharness/tmp/prompt-${run.runId}-${promptTag}.txt`;
          try {
            await fs.mkdir(path.join(run.root, ".sfharness", "tmp"), { recursive: true });
            await fs.writeFile(path.join(run.root, rel), p, "utf8");
            p =
              `Read the file ${rel} in this project COMPLETELY (it contains your full ` +
              `instructions, mandatory standards, and the task) and then carry out the task exactly.`;
          } catch {
            /* fall back to the inline prompt (may truncate) */
          }
        }
        const { args, viaStdin } = agentDef.build(p, stepModel, def.readOnly === true, streamJson);
        return spawnToStep(
          run,
          step,
          agentDef.bin,
          args,
          viaStdin ? p : undefined,
          streamJson ? makeClaudeTraceTransform(step) : undefined,
          (def.timeoutMinutes ?? 15) * 60_000,
        );
      };

      // Engine-driven task loop: one bounded agent spawn per pending task in
      // the machine-readable tasks file, dependency-ordered; each completion
      // is recorded deterministically (status + per-task usage + duration).
      if (def.taskLoop && def.tasksFile) {
        const rel = template(def.tasksFile, run).replace(/\\/g, "/");
        const { data } = await loadTasks(run.root, rel);
        const pending = data ? pendingInOrder(data) : [];
        if (data && pending.length > 0) {
          const totals = { inTokens: 0, outTokens: 0, costUsd: 0, estimated: false };
          let n = 0;
          for (const t of pending) {
            n++;
            const t0 = Date.now();
            const outStart = step.output.length;
            step.usage = undefined; // per-spawn usage lands here (claude: exact)
            step.output += `\n\n━━ ${t.id} (${n}/${pending.length}): ${t.title} ━━\n`;
            await persist(run);
            const latestReview = t.reviews?.length
              ? t.reviews[t.reviews.length - 1].comment
              : "";
            const taskPrompt =
              prompt +
              `\n\nCURRENT TASK — complete ONLY this one task now (the other tasks run as separate steps; do not start them):\n` +
              `${t.id}: ${t.title}\n` +
              (t.change ? `Mechanism: ${t.change}\n` : "") +
              `Files this task should touch: ${t.files.join(", ") || "(per the design)"}\n` +
              (t.test_scenarios?.length ? `Test scenarios: ${t.test_scenarios.join("; ")}\n` : "") +
              (t.traces?.length ? `Traces: ${t.traces.join(", ")}\n` : "") +
              (latestReview
                ? `REVIEWER COMMENT (mandatory — this reopened task's work order): ${latestReview}\n`
                : "");
            const ok = await spawnAgent(taskPrompt, `${def.id}-${t.id}`);
            const u =
              step.usage ??
              estimateUsage(run.agent, stepModel, taskPrompt, step.output.slice(outStart));
            totals.inTokens += u.inTokens;
            totals.outTokens += u.outTokens;
            totals.costUsd += u.costUsd;
            totals.estimated = totals.estimated || u.estimated;
            if (!ok) {
              step.usage = totals;
              step.output += `\n[engine] ${t.id} failed — remaining tasks stay pending in ${rel}`;
              return false;
            }
            const fresh = await loadTasks(run.root, rel);
            const ft = fresh.data?.tasks.find((x) => x.id === t.id);
            if (fresh.data && ft) {
              ft.status = "completed";
              ft.tokens_in = u.inTokens;
              ft.tokens_out = u.outTokens;
              ft.duration_s = Math.round((Date.now() - t0) / 1000);
              await saveTasks(run.root, rel, fresh.data);
            }
            await persist(run);
          }
          step.usage = totals;
          harvestAffectedFiles(run, step.output);
          return true;
        }
        step.output += `[engine] no valid tasks file or nothing pending (${rel}) — running as a single step\n`;
      }

      const ok = await spawnAgent(prompt, def.id);
      harvestAffectedFiles(run, step.output);
      if (!step.usage) step.usage = estimateUsage(run.agent, stepModel, prompt, step.output);
      return ok;
    }
    case "tasks-check": {
      // Deterministic validation of the agent-produced tasks file — bad
      // structure is caught by CODE before anything consumes it.
      const rel = template(def.tasksFile ?? "", run).replace(/\\/g, "/");
      if (!rel) {
        step.output = "[engine] tasks-check requires tasksFile";
        return false;
      }
      const { data, errors } = await loadTasks(run.root, rel);
      if (!data) {
        if (def.optional) {
          step.output = `no valid tasks file (${errors.join("; ")}) — step skipped`;
          step.status = "skipped";
          return true;
        }
        step.output = `tasks file invalid (${rel}):\n- ${errors.join("\n- ")}`;
        return false;
      }
      const order = pendingInOrder(data);
      step.output =
        `tasks file valid: ${data.tasks.length} task(s), ${order.length} pending\n` +
        `execution order: ${order.map((t) => t.id).join(" → ") || "(none pending)"}`;
      return true;
    }
    case "verify": {
      // Deterministic standards enforcement over the actual changed files —
      // catches violations regardless of which agent (or human) wrote them.
      const changed = (run.changes ?? []).filter((c) => c.status !== "deleted");
      if (changed.length === 0) {
        step.output = "no changed files to verify";
        return true;
      }
      const contents: { file: string; content: string }[] = [];
      for (const c of changed.slice(0, 100)) {
        const abs = path.join(run.root, c.file);
        try {
          const st = await fs.stat(abs);
          if (st.isFile() && st.size < 1_500_000) {
            contents.push({ file: c.file, content: await fs.readFile(abs, "utf8") });
          }
        } catch {
          /* deleted/renamed between steps — skip */
        }
      }
      const violations = checkStandards(contents);
      if (violations.length === 0) {
        step.output = `standards check passed (${contents.length} file(s))`;
        return true;
      }
      step.output = violations
        .map((v) => `${v.severity.toUpperCase().padEnd(8)} ${v.rule}  ${v.file}\n         ${v.detail}`)
        .join("\n");
      const errors = violations.filter((v) => v.severity === "error");
      if (errors.length > 0) {
        step.output += `\n\n${errors.length} error-level violation(s) — run blocked. Fix and re-run.`;
        return false;
      }
      step.output += "\n\nwarnings only — review them at the next gate.";
      return true;
    }
    case "cli": {
      if (def.bin !== "sf" && def.bin !== "git") {
        step.output = `binary not whitelisted: ${def.bin}`;
        return false;
      }
      const args = expandArgs(def.args ?? [], run);
      if (!args) {
        if (def.optional) {
          step.output = "nothing to act on — step skipped";
          step.status = "skipped";
          return true;
        }
        step.output = "no changed files to act on — nothing to validate/deploy";
        return false;
      }
      if (def.detached) {
        // long-lived server (e.g. sf lightning dev app): visible console the
        // user watches/closes; the run continues to the next step (a gate)
        try {
          const cmdline = [def.bin, ...args.map(winQuote)].join(" ");
          // single shell string: node's arg-quoting breaks `start` title parsing
          const child = spawn(`start "Dhruva" cmd /k "${cmdline}"`, {
            cwd: run.root,
            detached: true,
            stdio: "ignore",
            windowsHide: false,
            shell: true,
          });
          child.unref();
          step.output = `launched in a console window: ${def.bin} ${args.join(" ")}`;
          return true;
        } catch (e) {
          step.output = `could not launch: ${String(e)}`;
          return false;
        }
      }
      return spawnToStep(
        run,
        step,
        def.bin,
        args.map(winQuote),
        undefined,
        undefined,
        (def.timeoutMinutes ?? 15) * 60_000,
      );
    }
  }
}

/** Fill "{inputs.x}" and "{steps.id.output}" placeholders. */
function template(text: string, run: RunState): string {
  return text
    .replace(/\{inputs\.([\w-]+)\}/g, (_, k) => String(run.inputs[k] ?? ""))
    .replace(/\{steps\.([\w-]+)\.output\}/g, (_, id) => {
      const s = run.steps.find((x) => x.id === id);
      return s ? s.output.slice(0, 8000) : "";
    });
}

/** Parse a "FILES: a, b, c" line from agent output into run.affected —
 * project-relative paths only; anything absolute or escaping is dropped. */
function harvestAffectedFiles(run: RunState, output: string) {
  const m = output.match(/FILES:\s*([^\n]+)/);
  if (!m) return;
  const files = m[1]
    .split(",")
    .map((f) => f.trim().replace(/\\/g, "/").replace(/^["'`]|["'`]$/g, ""))
    .filter((f) => f && !f.includes("..") && !path.isAbsolute(f) && f.length < 300)
    .slice(0, 30);
  if (files.length) run.affected = files;
}

/** Expand argv templates. "{changedSourceDirs}" becomes repeated
 * --source-dir <file> pairs for every non-deleted changed file; returns null
 * when the expansion is required but there are no changed files. */
function expandArgs(argv: string[], run: RunState): string[] | null {
  const out: string[] = [];
  for (const a of argv) {
    if (a === "{changedSourceDirs}") {
      const files = (run.changes ?? []).filter((c) => c.status !== "deleted");
      if (files.length === 0) return null;
      // file names can be agent-created — sanitize like any templated value
      for (const f of files.slice(0, 50)) out.push("--source-dir", cliSafe(f.file));
    } else if (a === "{affectedSourceDirs}") {
      const files = run.affected ?? [];
      if (files.length === 0) return null;
      for (const f of files.slice(0, 30)) out.push("--source-dir", cliSafe(f));
    } else if (a.startsWith("{flag:")) {
      // "{flag:--synchronous:inputs.key}" → the bare flag only when truthy
      const m = a.match(/^\{flag:([\w-]+):inputs\.([\w-]+)\}$/);
      if (m && run.inputs[m[2]]) out.push(m[1]);
    } else if (a.startsWith("{opt:")) {
      // "{opt:--flag:inputs.key}" → ["--flag", value] only when value non-empty
      const m = a.match(/^\{opt:([\w-]+):inputs\.([\w-]+)\}$/);
      if (m) {
        const v = cliSafe(String(run.inputs[m[2]] ?? "").trim());
        if (v) out.push(m[1], v);
      }
    } else {
      out.push(cliSafe(template(a, run)));
    }
  }
  return out;
}

/** User-provided values that end up in argv must never carry shell
 * metacharacters (args pass through cmd.exe to resolve .cmd shims). */
function cliSafe(v: string): string {
  return v.replace(/["'`^&|<>%$;\r\n\t]/g, " ").trim();
}

/** Args pass through cmd.exe (shell:true resolves .cmd shims) — quote paths
 * with spaces; templates never contain quotes (whitelisted argv, not shell). */
function winQuote(a: string): string {
  return /[\s&|^<>%()]/.test(a) && !a.startsWith('"') ? `"${a}"` : a;
}

/** Translate claude stream-json lines into a human-readable live trace and
 * capture the exact usage from the final "result" event onto the step. */
function makeClaudeTraceTransform(step: StepState): (chunk: string) => string {
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
        if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
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
        /* partial or non-JSON line — ignore */
      }
    }
    return out;
  };
}

function spawnToStep(
  run: RunState,
  step: StepState,
  bin: string,
  args: string[],
  stdin?: string,
  transform?: (chunk: string) => string,
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: run.root,
      shell: true,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "true" },
    });
    activeChildren.set(run.runId, child);
    const timer = setTimeout(() => {
      step.output += "\n[engine] step timed out";
      // shell:true means child is cmd.exe — kill the whole tree or the real
      // CLI survives as an orphan still editing the project
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
      child.kill();
    }, timeoutMs);
    // EPIPE when the CLI exits before draining (e.g. expired login) must not
    // crash the server process
    child.stdin.on("error", () => {});
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    const push = (chunk: Buffer) => {
      const text = chunk.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
      const rendered = transform ? transform(text) : text;
      if (rendered && step.output.length < STEP_OUTPUT_CAP) {
        step.output += rendered;
      }
      void persist(run);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => {
      clearTimeout(timer);
      activeChildren.delete(run.runId);
      step.output += `\n[engine] could not start ${bin}: ${e.message}`;
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      activeChildren.delete(run.runId);
      step.output += `\n[exit ${code}]`;
      resolve(code === 0);
    });
  });
}

let persistChain = Promise.resolve();
async function persist(run: RunState) {
  // serialize writes; audit file lives with the project
  persistChain = persistChain.then(async () => {
    try {
      const dir = path.join(run.root, ".sfharness", "runs");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${run.runId}.json`), JSON.stringify(run, null, 2), "utf8");
    } catch {
      /* audit persistence is best-effort */
    }
  });
  await persistChain;
}
