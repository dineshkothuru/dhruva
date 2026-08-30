import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AgentId } from "@/lib/agents";
import { AGENTS } from "@/lib/agents";
import { takeSnapshot, changesSince, headCommit, commitRunResult } from "@/lib/snapshot";
import { STANDARDS_PROMPT, checkStandards } from "@/lib/standards";
import { persona, standardsFor } from "@/lib/standardsLibrary";
import { estimateUsage } from "@/lib/pricing";
import { loadTasks, saveTasks, pendingInOrder, reopenFromFindings } from "@/lib/workflows/tasks";
import { skillsPrompt } from "@/lib/projectSkills";
import { workRemaining, WORK_INSTRUCTION } from "@/lib/workflows/workRemaining";
import { resolveInside } from "@/lib/fsguard";
import { OUTCOME_INSTRUCTION } from "@/lib/outcome";
import { writeTranscript } from "@/lib/runTranscript";
import { checkCoverage } from "./traceability";
import { adoptForRun } from "@/lib/attachments";
import {
  COVERAGE_INSTRUCTION,
  FINDINGS_INSTRUCTION,
  parseFindings,
  reviewFeedback,
} from "@/lib/findings";
import {
  designFromOutput,
  extractDelta,
  madeProgress,
  statedOutcomes,
  type ReviewRecord,
} from "./artifacts";
import {
  awaitingDecision,
  decisionsOpen,
  openFor,
  fixableOpen,
  foldDecision,
  foldReview,
  parkable,
  parkBlocks,
  recordDecision as recordDocDecision,
  save as saveDesignDoc,
  load as loadDesignDoc,
  render as renderDesign,
  renderChanges,
  writeUpdate as writeDesignUpdate,
} from "./designDoc";
import type { BlockState } from "./artifacts";
import { checkEvidence, evidenceNote } from "./evidenceCheck";
import { costBucket, countBucket, durationBucket, tokensBucket, track } from "@/lib/telemetry";
import type { ChainLink, GateDecision, RunState, StepDef, StepState, WorkflowDef } from "./schema";
import { ROLE_TIER } from "./schema";

/** Deterministic workflow runner. Runs live in this server process (a local
 * single-user tool); every state change is persisted to
 * <project>/.dhruva/runs/<runId>.json - the audit trail. */

const runs = new Map<string, RunState>();
const gateWaiters = new Map<string, (decision: GateDecision) => void>(); // key: runId
// the live child process of each run's current step - so an abort can kill it
const activeChildren = new Map<string, ReturnType<typeof spawn>>();
/** Runaway backstop, NOT a content budget. The CLI has already generated and
 * billed every token by the time this applies, so it cannot make a step terser
 * (that is a sentence in the prompt); all it decides is what the harness keeps
 * in memory and writes to the run json. Set far above anything real - the
 * largest step output measured across real runs is 40,728 characters - so it
 * only ever trips on a process printing without end. */
const STEP_OUTPUT_CAP = 5_000_000;
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

/** Live runs for this project waiting on a human gate (in-memory only -
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
  const dir = path.join(root, ".dhruva", "runs");
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as RunState;
        if (!r.runId || !Array.isArray(r.steps)) continue;
        if (r.status === "running" || r.status === "waiting_gate") {
          r.status = "aborted";
          // normalize the steps too - a step frozen at "running" in a dead
          // run's audit must not render as working forever, and the reader
          // deserves to know WHY the run ended
          for (const s of r.steps) {
            if (s.status === "running" || s.status === "waiting_gate") {
              s.status = "failed";
              s.endedAt ??= Date.now();
              s.output +=
                "\n[engine] run ended while this step was in progress - the server process " +
                "restarted or was killed (dev-mode file edits recompile the app; the installed " +
                "desktop app is immune). Output above is the last saved state; re-run the workflow.";
            }
          }
        }
        byId.set(r.runId, r);
      } catch {
        /* corrupt audit file - skip */
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
  if (step) {
    // mark immediately - the UI must never show "working" on an aborted run,
    // even if the process tree takes time to die
    step.status = "failed";
    step.endedAt = Date.now();
    step.output += "\n[engine] aborted by user (Stop run) - the step's process was killed";
  }
  const child = activeChildren.get(runId);
  if (child?.pid) {
    // shell:true means the child is cmd.exe - kill the whole tree
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
  chain?: ChainLink[],
  chainIndex?: number,
  autoGate?: boolean,
  /** A chained phase inherits the previous phase's commits instead of taking
   * its own baseline - see the snapshot step for why. */
  inherit?: { baseCommit?: string; startCommit?: string },
): RunState | null {
  // One project, one run at a time.
  //
  // Every run on a project shares one working tree and one snapshot store, and
  // neither can be divided. Two runs editing the same files interfere directly:
  // one agent's edit lands on top of the other's, and each run's change list -
  // which the reviewer, verify-standards and the deploy all read - contains the
  // other's files. Pinning each run to its own baseline commit fixed the
  // bookkeeping, but no commit can separate work done in the same folder.
  //
  // The guard lives here rather than in the route so every caller is covered:
  // the API, a chained next phase, and anything added later.
  if (hasActiveRun(root)) return null;

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
  if (autoGate) run.autoGate = true;
  if (inherit?.baseCommit) run.baseCommit = inherit.baseCommit;
  // The chain's original "before" carries across every phase: a chain is one
  // piece of work, so undo on phase 3 must still reach the state before phase 1.
  if (inherit?.startCommit) run.startCommit = inherit.startCommit;
  void track("run_started", {
    workflow_id: def.id,
    agent,
    step_count: def.steps.length,
    chained: !!chain,
    unattended: autoGate === true,
  });
  if (chain && chainIndex !== undefined && chain[chainIndex]) {
    run.chain = chain.map((c) => ({ ...c }));
    run.chain[chainIndex].runId = run.runId;
    run.chainIndex = chainIndex;
  }
  runs.set(run.runId, run);
  // Take ownership of the files this run references before the first step
  // reads them: staged uploads move into .dhruva/runs/<runId>/attachments and
  // the recorded inputs are rewritten, so the audit points at the copy this
  // run actually used rather than a shared folder anyone can overwrite.
  void (async () => {
    for (const [k, v] of Object.entries(run.inputs)) {
      if (typeof v !== "string" || !v.includes(".dhruva/tmp/attachments/")) continue;
      const { text, moved } = await adoptForRun(run.root, run.runId, v).catch(() => ({
        text: v,
        moved: [] as string[],
      }));
      if (moved.length > 0) run.inputs[k] = text;
    }
    void execute(run, def); // fire and forget; UI polls state
  })();
  return run;
}

const MAX_REVISIONS_PER_GATE = 5;

/** Ceiling on auto-revise rounds before the human gate.
 *
 * The real stopping condition is `madeProgress`: a round that closes no finding
 * and does not reduce the criticals ends the loop, because spending another
 * fifteen minutes on it repeats the same work. This is only the backstop for a
 * loop that keeps finding something every time. Raised from 3 once findings
 * started converging (15 -> 12 -> 7 -> 7 on the first live run, against
 * 22 -> 12 -> 10 -> 14 before), where round 3 was a budget cut-off rather than
 * a natural end. */
const MAX_AUTO_REVISE_ROUNDS = 10;

/** Resume a failed/aborted run from its first incomplete step. Completed
 * steps keep their outputs (later prompts template from them) and approved
 * gates stay approved; everything from the failure point re-runs. Returns
 * null when the run is live, unknown, finished, or the workflow definition
 * has changed since (then a fresh start is the only honest option). */
export async function resumeRun(
  root: string,
  runId: string,
  roleModels?: RunState["roleModels"],
): Promise<RunState | null> {
  let run = runs.get(runId);
  if (!run) {
    try {
      run = JSON.parse(
        await fs.readFile(path.join(root, ".dhruva", "runs", `${runId}.json`), "utf8"),
      ) as RunState;
    } catch {
      return null;
    }
    // a DISK run still marked running/waiting_gate belongs to a dead server
    // process (restart killed it) - normalize like listRuns does, or the most
    // common death mode could never be resumed
    if (run && (run.status === "running" || run.status === "waiting_gate")) {
      run.status = "aborted";
      for (const s of run.steps) {
        if (s.status === "running" || s.status === "waiting_gate") {
          s.status = "failed";
          s.endedAt ??= Date.now();
        }
      }
    }
  }
  if (!run || run.root !== root) return null;
  if (run.status === "running" || run.status === "waiting_gate" || run.status === "done") {
    return null;
  }
  const { loadWorkflow } = await import("./custom");
  const def = await loadWorkflow(root, run.workflowId);
  if (!def) return null;
  // the definition must still match the recorded steps - resuming into a
  // changed workflow would execute steps the approvals never covered
  if (
    def.steps.length !== run.steps.length ||
    def.steps.some((s, i) => s.id !== run.steps[i].id)
  ) {
    return null;
  }
  const start = run.steps.findIndex((s) => s.status !== "done" && s.status !== "skipped");
  if (start === -1) return null;
  for (let k = start; k < run.steps.length; k++) {
    const s = run.steps[k];
    s.status = "pending";
    s.output = "";
    s.usage = undefined;
    s.startedAt = undefined;
    s.endedAt = undefined;
    s.model = undefined;
    s.modelFrom = undefined;
  }
  run.steps[start].output = "[engine] resumed - re-running from this step\n";
  // refresh model settings on resume - a run that failed BECAUSE of a bad
  // role model must be fixable by correcting OR CLEARING the setting and
  // resuming (an empty map means "all automatic", not "keep the old ones")
  if (roleModels !== undefined) {
    run.roleModels = roleModels;
    run.steps[start].output += "[engine] role-model settings refreshed from your current configuration\n";
  }
  run.status = "running";
  run.endCommit = undefined;
  runs.set(run.runId, run);
  await persist(run);
  void execute(run, def, start);
  return run;
}

async function execute(run: RunState, def: WorkflowDef, startIndex = 0) {
  await executeSteps(run, def, startIndex);
  // Pin the end state (without moving HEAD) so this run stays diffable after
  // later runs re-baseline - done for every terminal status incl. aborted.
  run.endCommit = (await commitRunResult(run.root, run.runId)) ?? undefined;
  await persist(run);
  // a line-oriented copy beside the JSON, so the record can be searched
  // cheaply instead of read whole
  await writeTranscript(run);
  const totalIn = run.steps.reduce((n, x) => n + (x.usage?.inTokens ?? 0), 0);
  const totalOut = run.steps.reduce((n, x) => n + (x.usage?.outTokens ?? 0), 0);
  const totalCost = run.steps.reduce((n, x) => n + (x.usage?.costUsd ?? 0), 0);
  const revisions = Object.values(run.revisions ?? {}).reduce((n, x) => n + x.length, 0);
  void track("run_finished", {
    workflow_id: run.workflowId,
    agent: run.agent,
    model: run.model,
    outcome: run.status,
    step_count: run.steps.length,
    chained: !!run.chain,
    unattended: run.autoGate === true,
    duration_bucket: durationBucket(Date.now() - run.createdAt),
    tokens_bucket: tokensBucket(totalIn + totalOut),
    cost_bucket: costBucket(totalCost),
    revisions,
    // how far it got - tells apart "failed at step 2" from "failed at 15"
    step_index: run.steps.filter((x) => x.status === "done").length,
  });
  await fireChain(run);
}

/** The manual-step contract, in ONE place next to the parser below.
 *
 * collectManual runs on EVERY agent step, but the instruction to emit these
 * lines was copied into five step files - and had already drifted into two
 * wordings. Any step can discover that a human must click something in Setup;
 * only five were told they could say so. */
const MANUAL_INSTRUCTION =
  `

MANUAL STEPS: if anything needs a HUMAN acting in the org that you cannot do ` +
  `from this machine (Setup toggles, secrets or Named Credential values, connected app ` +
  `approvals, production permission set assignment, sandbox refreshes, feature enablement), ` +
  `print one line each in exactly this form:
` +
  `MANUAL: <action> - <where, e.g. Setup path> - <before deploy|after deploy>
` +
  `Never silently skip or fake one. Print nothing if there are none.`;

/** Collect the agent's "MANUAL: <action> - <where> - <when>" lines onto the
 * run - the human checklist. Deterministic parse, deduped by text. */
function collectManual(run: RunState, def: StepDef, step: StepState) {
  // A step that has not read the org cannot know a human must act in it - see
  // StepDef.orgAware. Asked anyway, the requirement extraction guessed at
  // community sites and permission-set assignments a later step found already
  // in place. Not asked, and not collected if it volunteers one.
  if (def.orgAware === false) return;
  const lines = step.output.match(/^\s*\*{0,2}MANUAL:\s*(.+)$/gim) ?? [];
  if (lines.length === 0) return;
  run.manualSteps ??= [];
  for (const l of lines) {
    const text = l.replace(/^\s*\*{0,2}MANUAL:\s*/i, "").replace(/\*+$/, "").trim().slice(0, 400);
    if (text && !run.manualSteps.some((m) => m.text === text)) {
      run.manualSteps.push({ stepId: step.id, phase: run.workflowTitle, text });
    }
  }
}

/** Chain handoff: when a run that belongs to a multi-workflow chain finishes
 * CLEAN, start the next link with the same agent/model settings. A failed or
 * aborted run pauses the chain on purpose - resuming it to done re-fires. */
async function fireChain(run: RunState) {
  const chain = run.chain;
  const idx = run.chainIndex ?? -1;
  if (!chain || idx < 0 || idx + 1 >= chain.length) return;
  const nextLink = chain[idx + 1];
  const last = run.steps[run.steps.length - 1];
  const note = (line: string) => {
    if (last && !last.output.includes(line)) last.output += `\n${line}`;
  };
  if (run.status !== "done") {
    note(
      `[engine] chain paused - "${nextLink.title}" starts only after a clean finish ` +
        `(this run ${run.status}). Resume this run to continue the chain.`,
    );
    await persist(run);
    return;
  }
  if (nextLink.runId) return; // already fired (defensive)
  const { loadWorkflow } = await import("./custom");
  const def = await loadWorkflow(run.root, nextLink.workflowId);
  if (!def) {
    note(`[engine] chain broken - next workflow "${nextLink.workflowId}" no longer exists.`);
    await persist(run);
    return;
  }
  const inputs = { ...(nextLink.inputs ?? {}) };
  // the next phase consumes what this one produced, and those filenames are
  // stamped with THIS run's id - resolve that before handing over
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === "string" && v.includes("{prevRunId}")) {
      inputs[k] = v.replaceAll("{prevRunId}", run.runId);
    }
  }
  // same server-side injection a route-started run gets (project UX settings)
  if (def.inputs.some((i) => i.key === "uxEnabled")) {
    const { readProjectSettings } = await import("@/lib/projectSettings");
    const st = await readProjectSettings(run.root);
    inputs.uxEnabled = st.ux?.enabled === true;
    inputs.uxRules = st.ux?.rules ?? "";
    inputs.designDir = st.ux?.designDir || "docs/design";
  }
  const next = startRun(
    run.root,
    def,
    inputs,
    run.agent,
    run.model,
    run.roleModels,
    chain.map((c) => ({ ...c })),
    idx + 1,
    run.autoGate,
    { baseCommit: run.baseCommit, startCommit: run.startCommit ?? run.baseCommit },
  );
  if (next) {
    // same-tick after startRun (execute suspends at its first await), so this
    // lands before the new run's first persist - the checklist carries over
    if (run.manualSteps?.length) {
      next.manualSteps = [...run.manualSteps.map((m) => ({ ...m })), ...(next.manualSteps ?? [])];
    }
    nextLink.runId = next.runId;
    note(`[engine] chain: started "${nextLink.title}" (run ${next.runId})`);
    await persist(run);
  } else {
    // startRun refuses while another run holds the project. This run has
    // already finished, so a refusal here means something else was started
    // alongside it - say so rather than leaving the chain silently stalled with
    // no explanation of why the next phase never appeared.
    note(
      `[engine] chain: could not start "${nextLink.title}" - another run is active on this ` +
        `project. Start it again once that run finishes.`,
    );
    await persist(run);
  }
}

async function executeSteps(run: RunState, def: WorkflowDef, startIndex = 0) {
  for (let i = startIndex; i < def.steps.length; i++) {
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
    if (stepDef.skipIf && String(run.inputs[stepDef.skipIf] ?? "").trim()) {
      const adopted = await adoptArtifact(run, stepDef, String(run.inputs[stepDef.skipIf]));
      // Only skip when there is genuinely something to skip WITH. A reuse that
      // cannot be honoured runs the step and says why, rather than leaving
      // every later step to cite a document that was never written.
      if (adopted.ok) {
        step.status = "skipped";
        step.output = adopted.note;
        if (stepDef.artifact) step.artifact = template(stepDef.artifact, run).replace(/\\/g, "/");
        await persist(run);
        continue;
      }
      step.output = `${adopted.note}\n`;
    }
    // A work-check found the requirement already satisfied. Everything after it
    // exists to build, verify or ship a change that is not going to be made -
    // including the human gates, because there is nothing to approve.
    if (run.noWork) {
      step.status = "skipped";
      step.output = "skipped - no changes needed (see the work check above)";
      await persist(run);
      continue;
    }

    // Gates run here (not in runStep) so a "revise" decision can re-run the
    // steps this gate reviews - everything back to the nearest agent step -
    // with the reviewer's feedback injected, then gate again.
    if (stepDef.type === "gate") {
      let revisions = 0;
      let notice = ""; // survives re-render (e.g. "revision not possible")
      // Auto-approve clears a gate the preceding review PASSED. It does not
      // launder a failed one: on a real run the reviewer blocked the design
      // four times running and auto-approve sent it to the build anyway, with
      // five unresolved criticals and nothing anywhere announcing it.
      const blocked = blockedReviewBefore(run, def, i);
      const auto = run.autoGate === true && !blocked;
      if (run.autoGate === true && blocked) {
        notice +=
          `\n\n[engine] auto-approve held back - the review before this gate did not pass ` +
          `(${blocked}). This gate needs YOUR decision.`;
      }
      for (;;) {
        let decision: GateDecision;
        if (auto) {
          // Auto-approve. A run started with the chain card's box ticked clears
          // EVERY gate, in every phase of the chain, without stopping.
          //
          // This used to spawn an "AI gatekeeper" that read the gate and voted
          // approve / revise / escalate. That was a model impersonating a
          // reviewer: it cost a full agent run per gate, its judgement was not
          // reproducible, and its one real safety feature - escalating to the
          // human - depended on someone watching a pane that never notifies.
          // A flag the user set deliberately is more honest than a model
          // guessing what the user would have said.
          step.status = "running";
          step.startedAt ??= Date.now();
          step.output = template(stepDef.message ?? "Proceed?", run) + notice;
          notice = "";
          decision = { action: "approve" };
        } else {
          step.status = "waiting_gate";
          step.startedAt ??= Date.now();
          step.output = template(stepDef.message ?? "Proceed?", run) + notice;
          run.status = "waiting_gate";
          // register the waiter BEFORE persisting: persist rides a serialized
          // write chain, and an abort landing in that window would otherwise
          // find waiting_gate with no waiter to resolve - a permanent hang
          const decisionPromise = new Promise<GateDecision>((resolve) => {
            gateWaiters.set(run.runId, resolve);
          });
          await persist(run);
          decision = await decisionPromise;
        }
        // the DECISION only - never the reviewer's feedback text
        void track("gate_resolved", {
          workflow_id: run.workflowId,
          gate_decision: decision.action,
          unattended: auto,
          revisions,
          step_index: i,
        });
        if (decision.action === "approve") {
          run.status = "running";
          step.output += auto ? "\n→ approved automatically (gates set to auto-approve)" : "\n→ approved";
          await recordDecision(
            run,
            def,
            i,
            "approved",
            decision.feedback?.trim() ||
              (auto ? "Approved automatically (gates set to auto-approve)." : "Approved as it stands."),
            !auto,
          );
          step.status = "done";
          step.endedAt = Date.now();
          await persist(run);
          break;
        }
        // Set aside what is blocked on a human and carry on with the rest.
        // Five unanswered questions should not hold an otherwise finished epic.
        if (decision.action === "park") {
          const parked = await parkAtGate(run, def, i);
          step.output +=
            parked.length > 0
              ? `\n→ parked ${parked.length} requirement(s) awaiting a decision: ${parked.join(", ")}` +
                `\n[engine] they are kept in docs/pending-design.md with the questions that stopped ` +
                `them; the documents below are written from the rest.`
              : `\n→ nothing to park - no requirement is blocked solely on a human decision`;
          if (parked.length === 0) {
            notice = "\n\n→ nothing is blocked solely on a decision - approve, revise or abort";
            await persist(run);
            continue;
          }
          run.status = "running";
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
              ? "\n\n→ revision limit reached - approve or abort"
              : "\n\n→ revision is not possible at this gate (no earlier agent step) - approve or abort";
          continue;
        }
        const targetId = def.steps[from].id;
        run.revisions ??= {};
        (run.revisions[targetId] ??= []).push(decision.feedback.trim());
        // The reviewer between the target and this gate hears it too. Without
        // this, a finding the human overruled is raised again on the next
        // round exactly as though nobody had ruled on it - the instruction
        // reached the designer only, and the critic argued with a decision it
        // could not see.
        for (let k = from + 1; k < i; k++) {
          const d = def.steps[k];
          if (d.type !== "agent" || d.role !== "review") continue;
          (run.revisions[d.id] ??= []).push(
            `The human ruled at the gate. This outranks any finding: ` +
              `"${decision.feedback.trim()}". Do not re-raise what it settles.`,
          );
        }
        await recordDecision(run, def, i, "revise", decision.feedback.trim());
        step.output += `\n→ revision requested: ${decision.feedback.trim().slice(0, 300)}`;
        // the gate must NOT look armed while the replay runs - the UI renders
        // the approval panel purely off waiting_gate, and clicks during a
        // replay would be silent no-ops
        step.status = "running";
        run.status = "running";
        await persist(run);
        if (!(await replayRange(run, def, from, i, `gate revision ${revisions}`))) return;
        // loop: gate again on the revised state
      }
      continue;
    }

    step.status = "running";
    step.startedAt = Date.now();
    await persist(run);
    try {
      const ok = await runStepTracked(run, stepDef, step);
      step.endedAt = Date.now();
      if (!ok) {
        // WHICH KIND of step failed - never the message, which routinely
        // carries file paths and code
        void track("step_failed", {
          workflow_id: run.workflowId,
          step_type: stepDef.type,
          step_role: stepDef.role,
          agent: run.agent,
          model: step.model,
          step_index: i,
          error_class: classifyFailure(step.output),
          duration_bucket: durationBucket((step.endedAt ?? Date.now()) - (step.startedAt ?? Date.now())),
        });
        if (step.status === "running") step.status = "failed";
        if ((run.status as string) !== "aborted") run.status = "failed";
        await persist(run);
        return;
      }
      if (step.status === "running") step.status = "done";
      void track("step_finished", {
        workflow_id: run.workflowId,
        step_type: stepDef.type,
        step_role: stepDef.role,
        agent: run.agent,
        model: step.model,
        model_from: step.modelFrom,
        outcome: "done",
        step_index: i,
        duration_bucket: durationBucket((step.endedAt ?? Date.now()) - (step.startedAt ?? Date.now())),
        tokens_bucket: tokensBucket((step.usage?.inTokens ?? 0) + (step.usage?.outTokens ?? 0)),
        // how much a review actually caught - only the COUNT, never a finding
        findings_count:
          stepDef.role === "review" ? countBucket(parseFindings(step.output).findings.length) : undefined,
      });
      if (stepDef.type === "agent") collectManual(run, stepDef, step);
      // Bounded self-healing (before the human gate): a review step whose
      // verdict matches its trigger auto-revises its target with the findings
      // as feedback, then re-runs everything up to and including itself. The
      // following human gate always still fires - this pre-cleans what the
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
        const max = Math.min(Math.max(ar.maxRounds ?? 1, 1), MAX_AUTO_REVISE_ROUNDS);
        // When the target owns an artifact, the round is recorded into it and
        // the loop stops early on a round that closes nothing - a stall is not
        // worth another 15 minutes. Without an artifact this stays exactly as
        // it was: the trigger regex alone.
        const artifactRel = stepDef.reviewOf
          ? def.steps.find((s) => s.id === stepDef.reviewOf)?.artifact
          : undefined;
        const relPath = artifactRel ? template(artifactRel, run).replace(/\\/g, "/") : "";
        let prevRound: ReviewRecord | null = null;
        let stalled = false;
        let rounds = 0; // survives the loop, so the final state can be recorded
        let recordedOutput = "";
        for (
          let round = 1;
          re && from >= 0 && from < i && round <= max && !stalled && re.test(step.output);
          round++
        ) {
          rounds = round;
          if (relPath) {
            const rec = await recordRound(run, relPath, step.output, round, step);
            recordedOutput = step.output;
            // Nothing the design can close: the loop has done its job, and
            // what is left belongs to a human. Checked BEFORE progress,
            // because a round that closes findings and leaves only decisions
            // has converged, not stalled.
            const doc = await loadDesignDoc(run.root, relPath).catch(() => null);
            if (doc && fixableOpen(doc).length === 0 && decisionsOpen(doc).length > 0) {
              stalled = true;
              await persist(run);
              break;
            }
            if (rec && !madeProgress(prevRound, rec)) {
              step.output +=
                `\n\n[engine] auto-revise stopped at round ${round}: the last round closed no ` +
                `finding and did not reduce the criticals. Spending the remaining ` +
                `${max - round + 1} round(s) on it would repeat the same work - over to you.`;
              stalled = true;
              await persist(run);
              break;
            }
            prevRound = rec;
          }
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
          // Inject the findings into the prompt ONLY when the target has no
          // artifact. With one, the same findings already reached it through
          // the file its prompt reads, and injecting them again sends the whole
          // set twice - two copies that can disagree if either write failed.
          if (!def.steps[from].artifact) {
            run.revisions ??= {};
            (run.revisions[targetId] ??= []).push(
              `[auto-revise round ${round} - findings from ${stepDef.id}]\n${reviewFeedback(step.output)}`,
            );
          }
          step.output += `\n\n[engine] auto-revise round ${round}/${max}: replaying ${targetId}`;
          await persist(run);
          if (!(await replayRange(run, def, from, i + 1, `auto-revise round ${round}`))) return;
          // the replay rewrote this step's output - restore the round marker
          // so the trace SHOWS the self-healing happened (audit readability)
          step.output =
            `[engine] auto-revise round ${round}/${max} completed - "${targetId}" was reworked ` +
            `with the previous findings as mandatory feedback; below is the RE-REVIEW of the ` +
            `reworked output\n\n` + step.output;
          await persist(run);
        }
        // The loop exits on the review that finally PASSED (or on running out
        // of rounds), and that last review has not been recorded yet - without
        // this the artifact's final state would be the last needs_work round
        // and never show the pass that ended the loop.
        if (relPath && step.output !== recordedOutput) {
          await recordRound(run, relPath, step.output, rounds + 1, step);
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

/** Fold one review round into the artifact and return what it found, so the
 * caller can tell a round that moved from a round that went in circles.
 * Findings carry over by id: anything open before and not reported again is
 * recorded as closed. */
async function recordRound(
  run: RunState,
  rel: string,
  reviewOutput: string,
  round: number,
  step: StepState,
): Promise<ReviewRecord | null> {
  try {
    const findings = parseFindings(reviewOutput).findings;
    const nowIds = new Set(findings.map((f) => f.id));
    // What the reviewer SAID beats what the engine can infer. A finding it
    // called PARTIAL or STILL OPEN stays open even when it dropped out of the
    // findings list; absence only closes a finding it said nothing about.
    const said = statedOutcomes(reviewOutput);
    const folded = await foldReview(run.root, rel, reviewOutput, round, findings, said);
    if (!folded) return null;
    const disputed = [...said.partial, ...said.stillOpen].filter((id) => !nowIds.has(id));
    if (disputed.length > 0) {
      step.output +=
        `
[engine] kept open on the reviewer's own word: ${disputed.join(", ")} - ` +
        `reported PARTIAL or STILL OPEN but absent from the findings list.`;
    }
    if (folded.unassigned.length > 0 && findings.length > folded.unassigned.length) {
      step.output +=
        `\n[engine] ${folded.unassigned.length} finding(s) name no requirement and were filed ` +
        `under "## Review": ${folded.unassigned.map((f) => f.id).join(", ")}`;
    }
    step.output +=
      `\n[engine] ${folded.openCount} finding(s) open after round ${round}` +
      (folded.rec.closed.length ? `, closed ${folded.rec.closed.length} this round` : "") +
      ` - ${folded.fixableCount} the design can close, ${folded.decisions.length} needing a decision.`;
    if (folded.decisions.length > 0) {
      step.output +=
        `\n[engine] awaiting a human decision (the design cannot close these): ` +
        folded.decisions.map((f) => `${f.id} - ${f.question ?? f.title}`.slice(0, 120)).join(" | ");
    }
    // A round that leaves nothing the design can close has finished its job.
    // Chasing zero spends rounds failing to design around information nobody
    // has: on run d0e4f7bc-1d6 five findings sat open to the last round waiting
    // on another team's schema answer.
    if (folded.fixableCount === 0 && folded.decisions.length > 0) {
      step.output +=
        `\n[engine] nothing left that the design can close - the remaining ` +
        `${folded.decisions.length} finding(s) need a human. Over to you at the gate.`;
    }
    return folded.rec;
  } catch {
    return null; // the artifact is best-effort; never break a run over it
  }
}

/** Did the review immediately before this gate end unresolved?
 *
 * Looks back from the gate to the nearest review-role step and reads its
 * verdict. Returns a short reason when it did NOT pass, or "" when it passed,
 * when there is no review to consult, or when the step produced no verdict at
 * all - absence of evidence must not become an accusation, so an unparseable
 * review is treated as "nothing to hold back on" and the gate behaves as it
 * did before. */
function blockedReviewBefore(run: RunState, def: WorkflowDef, gateIndex: number): string {
  for (let k = gateIndex - 1; k >= 0; k--) {
    const d = def.steps[k];
    if (d.type === "gate") break; // an earlier gate already had its own say
    if (d.type !== "agent" || d.role !== "review") continue;
    const out = run.steps.find((s) => s.id === d.id)?.output ?? "";
    const verdict = out.match(/VERDICT:\s*([A-Z_]+)/i)?.[1]?.toUpperCase();
    if (!verdict) return "";
    if (verdict === "APPROVED" || verdict === "PASS") return "";
    const open = parseFindings(out).findings.filter((f) => f.severity === "critical").length;
    return open > 0
      ? `${d.id}: ${verdict}, ${open} critical finding${open === 1 ? "" : "s"} open`
      : `${d.id}: ${verdict}`;
  }
  return "";
}

/** Re-run steps [from, to) against the current run state (revision feedback
 * already recorded). Gates inside the range were already approved and are
 * never replayed. Returns false when a replayed step fails (run marked). */
async function replayRange(
  run: RunState,
  def: WorkflowDef,
  from: number,
  to: number,
  reason = "replayed",
): Promise<boolean> {
  for (let k = from; k < to; k++) {
    const replayDef = def.steps[k];
    if (replayDef.type === "gate") continue;
    if (replayDef.onlyIf && !run.inputs[replayDef.onlyIf]) continue;
    const replayStep = run.steps.find((s) => s.id === replayDef.id)!;
    // Keep the attempt that is about to be overwritten. Without this the run
    // history shows a single row for a step that ran three times, and every
    // earlier version is lost - the audit says a design was reworked but not
    // what any round of it said.
    if (replayStep.output) {
      (replayStep.attempts ??= []).push({
        output: replayStep.output,
        status: replayStep.status,
        startedAt: replayStep.startedAt,
        endedAt: replayStep.endedAt,
        usage: replayStep.usage,
        model: replayStep.model,
        supersededBy: reason,
      });
    }
    replayStep.output = "";
    replayStep.usage = undefined;
    replayStep.status = "running";
    replayStep.startedAt = Date.now();
    // and clear the previous run's end time - leaving it made a re-running
    // step carry an endedAt EARLIER than its startedAt, which renders as a
    // negative duration and reads as "already finished"
    replayStep.endedAt = undefined;
    await persist(run);
    const ok = await runStepTracked(run, replayDef, replayStep);
    replayStep.endedAt = Date.now();
    if (!ok) {
      if (replayStep.status === "running") replayStep.status = "failed";
      if ((run.status as string) !== "aborted") run.status = "failed";
      await persist(run);
      return false;
    }
    if (replayStep.status === "running") replayStep.status = "done";
    if (replayDef.type === "agent") collectManual(run, replayDef, replayStep);
    await persist(run);
  }
  return true;
}

/** The nearest agent step before index i - the step a gate's revision re-runs. */
/** Reduce a failure to one of a fixed set of causes. The raw output is never
 * transmitted; only which bucket it fell into, so failures can be ranked
 * without exposing what the agent was working on. */
function classifyFailure(output: string): string {
  const t = output.slice(-4000).toLowerCase();
  if (/timed out|timeout/.test(t)) return "timeout";
  if (/aborted by user/.test(t)) return "user_abort";
  if (/enoent|not recognized|command not found|is not installed/.test(t)) return "cli_missing";
  if (/not logged in|unauthorized|authentication|invalid api key|401/.test(t)) return "auth";
  if (/rate limit|quota|429|too many requests/.test(t)) return "rate_limit";
  if (/permission denied|read-only|denied/.test(t)) return "permission";
  if (/invalid model|unknown model|model not found/.test(t)) return "bad_model";
  if (/econnreset|enotfound|network|socket hang up/.test(t)) return "network";
  if (/exit [1-9]/.test(t)) return "nonzero_exit";
  return "other";
}

function nearestAgentIndex(def: WorkflowDef, i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (def.steps[j].type === "agent") return j;
  }
  return -1;
}

/** Run a step and, when it declares one, write its artifact.
 *
 * This wrapper exists because there are TWO paths into a step: the executor's
 * main loop and replayRange, which a rework uses. Putting the artifact write in
 * the main loop alone meant the revised design was never written back - the
 * reviewer would have re-read the FIRST design on every round, which is exactly
 * the bug this whole change is meant to remove. Every path goes through here. */
/** A declared contract that produced nothing parseable is a FAILURE, not a
 * quiet fallback. This is the exact shape of the bug that started all of it: a
 * review yielding zero parseable findings degraded to a text slice, and the
 * rework was handed 4,000 characters of terminal trace instead. */
function contractHeld(def: StepDef, output: string): string {
  if (def.emits === "findings") {
    if (parseFindings(output).findings.length > 0) return "";
    if (/VERDICT:\s*(APPROVED|PASS)/i.test(output)) return ""; // a clean pass has none
    return `declared emits: "findings" but produced no parseable finding and no passing verdict`;
  }
  if (def.emits === "coverage") {
    return /COVERAGE:\s*(COMPLETE|INCOMPLETE)/i.test(output)
      ? ""
      : `declared emits: "coverage" but produced no COVERAGE: line`;
  }
  return "";
}

async function runStepTracked(run: RunState, def: StepDef, step: StepState): Promise<boolean> {
  const ok = await runStep(run, def, step);
  if (ok && def.emits) {
    const broken = contractHeld(def, step.output);
    if (broken) {
      step.output +=
        `\n[engine] output contract not met - ${broken}. The step is failed rather than ` +
        `passed on, because everything downstream reads that contract.`;
      await persist(run);
      return false;
    }
  }
  // Only an AGENT authors an artifact. `solution-design.work-check` also
  // declares `artifact: design.md` - it reads the design to decide whether any
  // work remains - and without this guard its own report ("items: 34, already
  // implemented: 3") would be written OVER the design it just read.
  if (ok && def.type === "agent" && def.artifact && step.output) {
    const rel = template(def.artifact, run).replace(/\\/g, "/");
    // the transcript is not the design: strip the CLI's own trace and trailer
    const design = designFromOutput(step.output);
    // an empty extraction would blank the artifact and take the previous design
    // with it - keep what is already on disk instead
    if (design.trim().length === 0) {
      step.output += `\n[engine] nothing but tool trace in this step's output - ${rel} left as it was`;
    } else {
      // Round n = the attempts already recorded, plus this one.
      const round = (step.attempts?.length ?? 0) + 1;
      const wrote = await writeDesignUpdate(run.root, rel, design, round, extractDelta(design)).catch(() => null);
      if (!wrote) {
        step.output += `\n[engine] could not write ${rel} - the next rework will not see this design`;
      } else if (wrote.note) {
        step.output += `\n[engine] ${wrote.note}`;
      }
      // Downstream steps quote this step; from here on that quote is the
      // document, not the transcript.
      if (wrote && wrote.mode !== "refused") step.artifact = rel;
      if (wrote?.mode === "refused") {
        step.output +=
          `\n[engine] the step is failed rather than passed on: the design on disk is the ` +
          `last good one, and continuing would review a document this step did not produce.`;
        await persist(run);
        return false;
      }
      // Count the source document's own units against what the design claims.
      // Arithmetic, not opinion: the BRD numbers itself, so a dropped AC is a
      // fact rather than something a reviewer has to happen to notice.
      //
      // Counted against the DOCUMENT, not this step's output: a delta carries
      // three blocks, and measuring coverage against those would report the
      // other thirty-one as uncovered every round.
      const whole = await fs
        .readFile(path.join(run.root, rel), "utf8")
        .catch(() => design);
      // Existence is arithmetic, not opinion. The biggest class of review
      // finding is the design citing something this org does not have; a grep
      // settles it before the next round instead of after a 15-minute review.
      const ev = await checkEvidence(run.root, whole).catch(() => null);
      const note = ev ? evidenceNote(ev) : "";
      if (note) step.output += `\n[engine] ${note}`;

      const cov = await checkCoverage(
        run.root,
        String(run.inputs.requirement ?? ""),
        whole,
      ).catch(() => null);
      if (cov && cov.uncited.length > 0) {
        step.output +=
          `\n[engine] requirement coverage: ${cov.units.length - cov.uncited.length}/${
            cov.units.length
          } source units claimed by a BRD-REF. NOT claimed by any REQ block: ${cov.uncited.join(", ")}`;
      } else if (cov) {
        step.output += `\n[engine] requirement coverage: all ${cov.units.length} source units claimed.`;
      }
    }
  }
  return ok;
}

/** Backslashes to forward slashes. A char code rather than a regex literal:
 * the escape in /\\/g has been silently eaten by tooling more than once
 * in this file, and the result parses as an unterminated regex. */
function toPosix(p: string): string {
  return p.split(String.fromCharCode(92)).join("/");
}

/** Park every requirement that is blocked only on a human decision.
 *
 * The design keeps its work; the parked blocks move to `pending-design.md`
 * with the questions that stopped them, and the rest of the pipeline builds
 * documents from what proceeded. When the answers come back they are picked up
 * in a later run rather than redesigned. */
async function parkAtGate(run: RunState, def: WorkflowDef, gateIndex: number): Promise<string[]> {
  const targetId =
    def.steps[gateIndex].reviseTarget ?? def.steps[nearestAgentIndex(def, gateIndex)]?.id;
  const rel = run.steps.find((s) => s.id === targetId)?.artifact;
  if (!rel) return [];
  const doc = await loadDesignDoc(run.root, toPosix(rel)).catch(() => null);
  if (!doc) return [];
  const gate = doc.decisions.length + 1;
  const ids = parkable(doc).map((b) => b.id);
  if (ids.length === 0) return [];
  const parked = parkBlocks(doc, ids, gate);
  recordDocDecision(doc, {
    action: "approved",
    text:
      `Proceeded with the requirements that were ready. Parked ${parked.length} blocked on a ` +
      `decision: ${parked.join(", ")}. See pending-design.md.`,
  });
  await saveDesignDoc(run.root, toPosix(rel), doc).catch(() => {});
  return parked;
}

/** Bring an existing document into a run whose producing step was skipped.
 *
 * Skipping the WORK must not skip the OUTPUT: every downstream step still
 * quotes `{steps.requirements.output}` and still expects the file where the
 * step would have written it. So the named file is copied to the step's own
 * artifact path, and from there the run cannot tell the difference. */
async function adoptArtifact(
  run: RunState,
  def: StepDef,
  source: string,
): Promise<{ ok: boolean; note: string }> {
  const no = (why: string) => ({ ok: false, note: `[engine] ${why} - running the step instead.` });
  if (!def.artifact) return no("nothing to adopt into");
  const rel = template(def.artifact, run).replace(/\\/g, "/");

  // `true` means "use what was attached to this run". Anything else is a path.
  const candidates: string[] = [];
  if (source === "true") {
    const dir = path.join(run.root, ".dhruva", "runs", run.runId, "attachments");
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (/\.(md|markdown|txt)$/i.test(name)) candidates.push(path.join(dir, name));
    }
    if (candidates.length === 0) return no("no attached text file to adopt");
  } else {
    const src = resolveInside(run.root, toPosix(source.trim()));
    if (!src) return no(`"${source}" is outside this project`);
    candidates.push(src);
  }

  // It must LOOK like what the step would have produced. On a real run the BRD
  // extract was attached instead of a requirement list; adopting a 151 KB
  // source document as "the frozen requirements" would have had every later
  // step citing nonsense. The wrong file costs the four minutes it was meant to
  // save, and nothing else.
  const shape = /^###[ \t]+REQ-\d+/m;
  for (const src of candidates) {
    const body = await fs.readFile(src, "utf8").catch(() => "");
    const name = path.basename(src);
    if (!body.trim()) continue;
    if (!shape.test(body)) {
      return no(`"${name}" is not a requirement list (no "### REQ-nnn" blocks)`);
    }
    const abs = path.join(run.root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
    await fs.writeFile(abs, body, "utf8").catch(() => {});
    const n = (body.match(/^###[ \t]+REQ-\d+/gm) ?? []).length;
    return {
      ok: true,
      note:
        `[engine] step skipped - adopted ${name} as ${rel} ` +
        `(${n} requirement(s), ${(body.length / 1024).toFixed(1)}k chars). Nothing was re-extracted.`,
    };
  }
  return no("none of the attached files could be read");
}

/** Write a gate's decision into the document the gate was ruling on.
 *
 * The document is the one owned by the gate's revise target - the step whose
 * work is being judged. `freeze` stamps every block `approved` on a real human
 * approval, which is the only place that state is ever set: an auto-approved
 * run has not been ruled on by anyone, so it freezes nothing. */
async function recordDecision(
  run: RunState,
  def: WorkflowDef,
  gateIndex: number,
  action: "approved" | "revise",
  text: string,
  freeze = false,
): Promise<void> {
  const targetId = def.steps[gateIndex].reviseTarget ?? def.steps[nearestAgentIndex(def, gateIndex)]?.id;
  const rel = run.steps.find((s) => s.id === targetId)?.artifact;
  if (!rel) return;
  await foldDecision(run.root, rel, { action, text, freeze }).catch(() => false);
}

/** The design document, for the END of the prompt.
 *
 * It used to sit inside the state block, ahead of the step's own instructions.
 * On run d0e4f7bc-1d6 that put 88 KB of document between the agent and its
 * task: the instructions began at offset 93,720 of a 147 KB prompt, and the
 * revision that read it skimmed - it declared 32 of 34 blocks unchanged,
 * ignored all 22 the engine had listed as open, and edited one marked "do not
 * touch". The authoring pass, which inlines no document, had worked properly on
 * the same model minutes earlier.
 *
 * So: task first, data last, and a one-line restatement after the data. The
 * reviewer's prompt was already built this way and did not suffer. */
async function designDocumentBlock(run: RunState, def: StepDef): Promise<string> {
  if (!def.artifact) return "";
  const rel = toPosix(template(def.artifact, run));
  const doc = await loadDesignDoc(run.root, rel).catch(() => null);
  if (!doc || doc.blocks.length === 0) return "";
  return (
    `\n\n--- CURRENT DESIGN DOCUMENT (reference; the task is stated above) ---\n` +
    `${renderDesign(doc)}\n` +
    `--- end design document ---\n\n` +
    `Now produce the DELTA exactly as instructed above: only the blocks you changed ` +
    `or are answering a finding on, each field complete, and a response to EVERY id ` +
    `on that block's OPEN FINDINGS line.\n`
  );
}

/** Tell an authoring step, in its own prompt, whether it is writing a design
 * or revising one - and hand it the document rather than asking it to look.
 *
 * Run 1e3dc542-bbc round 4: the step's glob does not traverse dot-directories,
 * so `.dhruva/runs/<id>/docs/design.md` came back "No matches found", the agent
 * concluded no prior design existed, and re-authored from scratch - discarding
 * three rounds of accepted fixes. Rounds 2 and 3 hit the same empty glob and
 * only recovered because they happened to keep digging with a directory
 * listing. A step must not have to FIND its own previous work, so the engine
 * inlines it and says which blocks are in play. */
async function designStateBlock(run: RunState, def: StepDef): Promise<string> {
  // A review step gets the other half of the picture: what moved since it last
  // looked. Without it a reviewer can read the current design and the fix the
  // designer claims to have made, but cannot see whether the text actually
  // changed - so it cannot tell a real fix from a restated one.
  if (!def.artifact && def.reviewOf) {
    const target = run.steps.find((s) => s.id === def.reviewOf);
    if (!target?.artifact) return "";
    const doc = await loadDesignDoc(run.root, toPosix(target.artifact)).catch(() => null);
    if (!doc) return "";
    const round = (target.attempts?.length ?? 0) + 1;
    const diff = renderChanges(doc, round);
    return diff
      ? `\n\n=== CHANGED SINCE YOUR LAST REVIEW (round ${round}) ===\n${diff}` +
          `=== END CHANGES ===\n\n`
      : "";
  }
  if (!def.artifact) return "";
  const rel = toPosix(template(def.artifact, run));
  const doc = await loadDesignDoc(run.root, rel).catch(() => null);
  const current = doc ? renderDesign(doc) : "";
  if (!doc || doc.blocks.length === 0 || !current.trim()) {
    return (
      `\n\n=== DESIGN STATE ===\n` +
      `No design exists for this run yet. You are AUTHORING: output the complete ` +
      `design, one block per requirement, inside the DESIGN fence. Do NOT emit a DELTA.\n` +
      `=== END DESIGN STATE ===\n\n`
    );
  }
  const by = (want: BlockState) => doc.blocks.filter((b) => b.state === want).map((b) => b.id);
  // Split "open" by WHY, because the two need opposite things from the
  // designer: a block with findings gets fixed or defended; a block held only
  // by its own OPEN-CONFIRMED has nothing to answer and must be left alone for
  // the human, not quietly settled to clear the state.
  const waiting = doc.blocks
    .filter((b) => b.state === "open" && openFor(doc, b.id).length === 0 && awaitingDecision(b))
    .map((b) => b.id);
  const isWaiting = new Set(waiting);
  const line = (label: string, list: string[]) =>
    list.length ? `  ${label.padEnd(28)} ${list.join(", ")}\n` : "";
  // A fact the engine established, handed over before the next pass rather than
  // left for a review round to discover.
  const ev = await checkEvidence(run.root, current).catch(() => null);
  const evLine = ev && ev.missing.length ? `\nENGINE CHECK - ${evidenceNote(ev)}\nFix these blocks.\n` : "";
  return (
    `\n\n=== DESIGN STATE ===\n` +
    `You are REVISING. The complete current design is at the END of this prompt - ` +
    `it is the authoritative copy, so do NOT search the filesystem for it.\n\n` +
    line("open", by("open").filter((id) => !isWaiting.has(id))) +
    line("awaiting a decision", waiting) +
    line("approved - reviewer objects", by("approved-objected")) +
    line("clean (do not touch)", by("clean")) +
    line("approved (do not touch)", by("approved")) +
    evLine +
    `=== END DESIGN STATE ===\n\n` +
    // The document itself is returned separately - see designDocumentBlock.
    ""
  );
}

/** The design text a work-check should read.
 *
 * Named explicitly by the step rather than inferred: `artifact` for a workflow
 * whose design step writes a curated document, `reviewOf` for one whose design
 * lives in the step output. Both are existing conventions, and being explicit
 * matters here more than convenience - this is the input to a decision that can
 * end a run, so it must be obvious from the workflow file which text drives it.
 *
 * The artifact wins when both are present: it is the curated design, whereas
 * the output is a transcript that happens to contain one. */
async function designText(run: RunState, def: StepDef): Promise<string> {
  if (def.artifact) {
    const abs = resolveInside(run.root, toPosix(template(def.artifact, run)));
    if (abs) {
      const text = await fs.readFile(abs, "utf8").catch(() => "");
      if (text.trim()) return text;
    }
  }
  if (def.reviewOf) {
    return run.steps.find((s) => s.id === def.reviewOf)?.output ?? "";
  }
  return "";
}

async function runStep(run: RunState, def: StepDef, step: StepState): Promise<boolean> {
  switch (def.type) {
    case "snapshot": {
      // A chained phase keeps the baseline it inherited rather than taking a
      // new one. Its FIRST snapshot would otherwise commit everything the
      // earlier phase produced, making that work part of the baseline and so
      // invisible: a design -> implement chain would report the implementation
      // only, and the documents the design phase wrote would vanish from the
      // chain's account of itself.
      //
      // Only the opening snapshot is skipped. A `rebaseline` later in the same
      // phase is a deliberate "the org refresh is not our change" and still
      // moves the baseline.
      const isChainedPhase = (run.chainIndex ?? 0) > 0;
      const first = run.steps.findIndex((s) => s.type === "snapshot") === run.steps.indexOf(step);
      if (isChainedPhase && first && run.baseCommit) {
        step.output =
          `keeping the baseline inherited from the previous phase (${run.baseCommit.slice(0, 8)})\n` +
          "[engine] a fresh snapshot here would absorb the previous phase's work into the baseline";
        step.status = "skipped";
        return true;
      }
      const ok = await takeSnapshot(run.root);
      if (ok) {
        run.baseCommit = (await headCommit(run.root)) ?? undefined;
        // Recorded once. A later rebaseline moves baseCommit on purpose; this
        // stays put so undo always has the run's true starting state.
        run.startCommit ??= run.baseCommit;
      }
      step.output = ok ? "baseline snapshot taken" : "snapshot unavailable (git missing?)";
      return ok;
    }
    case "changes": {
      // pin what this diff is AGAINST before anything moves HEAD on
      step.baseCommit = (await headCommit(run.root)) ?? undefined;
      // Diff against THIS run's baseline, not whatever HEAD is now. HEAD is
      // shared by every run on the project, so another run snapshotting would
      // otherwise swallow this run's work into the baseline and report nothing.
      const changes = await changesSince(run.root, run.baseCommit);
      if (changes === null) {
        step.output = "snapshot store unavailable";
        return false;
      }
      run.changes = changes;
      // A zero-change run is a legitimate outcome - the requirement may already
      // be satisfied on disk - but it must never READ like a successful build
      // and deploy. Every step downstream of here needs changed files, so they
      // will all skip; saying so once, here, is what makes the trace honest.
      step.output = changes.length
        ? changes.map((c) => `${c.status.padEnd(8)} ${c.file}`).join("\n")
        : [
            "no files changed - nothing was produced by this run",
            "",
            "[engine] the steps that follow all act on changed files, so they will be",
            "skipped. Nothing has been validated, tested or deployed.",
            "If you expected changes, check the implement step's output: the usual",
            "cause is that the requirement was already satisfied on disk.",
          ].join("\n");
      return true;
    }
    case "gate": {
      // gates are handled by the executor (revise loop); reaching here is a bug
      step.output = "[engine] gate reached runStep - executor should handle gates";
      return false;
    }
    case "agent": {
      const agentDef = AGENTS[run.agent];
      // Ground the agent explicitly in the attached folder (prompt clarity +
      // audit-log readability; the cwd already enforces it technically).
      // Standards are injected by the ENGINE - same rules, verbatim, for
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
      // project knowledge (.dhruva/skills/*.md) - the org-specific layer,
      // injected for every vendor; audited per step below
      const skills = await skillsPrompt(run.root, scopeFiles).catch(() => ({ block: "", names: [], chars: 0 }));
      // Reviewer feedback from gates: mandatory, most recent last.
      const feedback = run.revisions?.[def.id];
      const feedbackBlock =
        feedback && feedback.length > 0
          ? `\n\nREVIEWER INSTRUCTIONS (mandatory - this is a revision of your earlier output; follow every point):\n${feedback
              .map((f, n) => `${n + 1}. ${f}`)
              .join("\n")}`
          : "";
      const stateBlock = await designStateBlock(run, def);
      const documentBlock = await designDocumentBlock(run, def);
      const docs = await quotedDocs(run, def.prompt ?? "");
      const prompt =
        `You are working inside the Salesforce DX project at ${run.root} ` +
        `(your current working directory). Only read and modify files in this project.\n` +
        `CRITICAL: when the task references a document, attachment, requirement file, or design ` +
        `file, read it COMPLETELY before acting - if your file-reading tool returns only part of ` +
        `it (e.g. the first 2000 lines), keep reading with offsets until the end of the file. ` +
        `Never analyse, design, or implement from a partially read document; if a referenced ` +
        `document cannot be fully read, say so explicitly instead of proceeding.\n\n` +
        (role ? `${role}\n\n` : "") +
        `MANDATORY TEAM STANDARDS:\n${rules}\n` +
        skills.block +
        `\n` +
        stateBlock +
        template(def.prompt ?? "", run, docs) +
        feedbackBlock +
        // One source of truth per machine-read contract: the engine appends
        // them, so every step gets the exact text its parser expects and a
        // prompt can never drift from the parser. The findings shape was
        // written out longhand in five separate review steps before this.
        (def.emits === "findings" ? FINDINGS_INSTRUCTION : "") +
        (def.emits === "coverage" ? COVERAGE_INSTRUCTION : "") +
        (def.emits === "work" ? WORK_INSTRUCTION : "") +
        (def.orgAware === false ? "" : MANUAL_INSTRUCTION) +
        OUTCOME_INSTRUCTION +
        // Data last: the document the step works ON goes after the task and the
        // contracts, never before them.
        documentBlock;
      // Model resolution, most specific wins:
      // 1. the user's per-ROLE model for this run (the Models-by-role setting)
      // 2. the role's tier through the agent's shipped tiers map
      // 3. the run's selected model / CLI default.
      const roleModel = def.role ? run.roleModels?.[def.role] : undefined;
      const tierModel = def.role ? agentDef.tiers[ROLE_TIER[def.role]] : undefined;
      const stepModel = roleModel || tierModel || run.model;
      // audit WHY this model was chosen, not just which
      step.modelFrom = roleModel
        ? `your "${def.role}" role setting`
        : tierModel
          ? `shipped default for the "${def.role}" role`
          : run.model
            ? "run model"
            : "CLI default";
      // the model is part of the step's log too, so the trace reads standalone
      step.output += `[engine] model requested: ${stepModel || "(CLI default)"} - ${step.modelFrom}\n`;
      if (skills.names.length > 0) {
        step.output += `[engine] project skills injected: ${skills.names.join(", ")} (${(skills.chars / 1000).toFixed(1)}k chars)\n`;
      }
      step.model = stepModel || "default";
      // claude: stream-json gives a LIVE trace (tool uses + text as produced)
      // and exact token usage in the final event; others stream plain text.
      const streamJson = run.agent === "claude";
      const spawnAgent = async (fullPrompt: string, promptTag: string): Promise<boolean> => {
        let p = fullPrompt;
        // Inline-prompt agents (copilot) hit cmd.exe's ~8k command-line limit -
        // the standards alone exceed it and the task would be truncated away.
        // Write the full prompt to a harness file and pass a short pointer.
        if (run.agent === "copilot") {
          const rel = `.dhruva/tmp/prompt-${run.runId}-${promptTag}.txt`;
          try {
            await fs.mkdir(path.join(run.root, ".dhruva", "tmp"), { recursive: true });
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
              `\n\nCURRENT TASK - complete ONLY this one task now (the other tasks run as separate steps; do not start them):\n` +
              `${t.id}: ${t.title}\n` +
              (t.change ? `Mechanism: ${t.change}\n` : "") +
              `Files this task should touch: ${t.files.join(", ") || "(per the design)"}\n` +
              (t.test_scenarios?.length ? `Test scenarios: ${t.test_scenarios.join("; ")}\n` : "") +
              (t.traces?.length ? `Traces: ${t.traces.join(", ")}\n` : "") +
              (latestReview
                ? `REVIEWER COMMENT (mandatory - this reopened task's work order): ${latestReview}\n`
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
              step.output += `\n[engine] ${t.id} failed - remaining tasks stay pending in ${rel}`;
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
        step.output += `[engine] no valid tasks file or nothing pending (${rel}) - running as a single step\n`;
      }

      const ok = await spawnAgent(prompt, def.id);
      harvestAffectedFiles(run, step.output);
      if (!step.usage) step.usage = estimateUsage(run.agent, stepModel, prompt, step.output);
      return ok;
    }
    case "work-check": {
      // Does the approved design leave anything to build? Counted from the
      // design's own per-item statuses, so CODE decides whether to proceed
      // rather than an agent being asked to implement nothing.
      const design = await designText(run, def);
      if (!design) {
        step.output =
          "[engine] no design output found to check - continuing as though work remains";
        return true;
      }
      const report = workRemaining(design);
      const lines = [`basis: ${report.basis}`];
      if (report.total > 0) {
        lines.push(`items: ${report.total}, already implemented: ${report.satisfied}`);
        if (report.pendingIds.length > 0) {
          lines.push(`still to build: ${report.pendingIds.join(", ")}`);
        }
      }

      if (report.verdict === "none") {
        run.noWork = true;
        step.output = [
          "NO CHANGES NEEDED - the requirement is already satisfied in this project.",
          "",
          ...lines,
          "",
          "[engine] the remaining steps are skipped: there is nothing to implement,",
          "validate or deploy. Nothing in this project was modified.",
        ].join("\n");
        return true;
      }

      // "unknown" continues. A design with no status structure must never be
      // read as "nothing to do" - only an explicit, complete statement of
      // satisfaction may close a run.
      step.output = [
        report.verdict === "some" ? "Work remains - continuing." : "Cannot tell - continuing.",
        "",
        ...lines,
      ].join("\n");
      return true;
    }
    case "tasks-check": {
      // Deterministic validation of the agent-produced tasks file - bad
      // structure is caught by CODE before anything consumes it.
      const rel = template(def.tasksFile ?? "", run).replace(/\\/g, "/");
      if (!rel) {
        step.output = "[engine] tasks-check requires tasksFile";
        return false;
      }
      const { data, errors } = await loadTasks(run.root, rel);
      if (!data) {
        if (def.optional) {
          step.output = `no valid tasks file (${errors.join("; ")}) - step skipped`;
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
      // Deterministic standards enforcement over the actual changed files -
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
          /* deleted/renamed between steps - skip */
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
        step.output += `\n\n${errors.length} error-level violation(s) - run blocked. Fix and re-run.`;
        return false;
      }
      step.output += "\n\nwarnings only - review them at the next gate.";
      return true;
    }
    case "cli": {
      if (def.bin !== "sf" && def.bin !== "git") {
        step.output = `binary not whitelisted: ${def.bin}`;
        return false;
      }
      const args = expandArgs(def.args ?? [], run);
      if (!args) {
        // expandArgs returns null ONLY when a file-list placeholder resolved to
        // zero files - never for a malformed command. So this is a no-work
        // condition, not a failure, and it must not be treated as one.
        //
        // It used to fail the run unless the step was `optional`, which
        // conflated two different things. `optional` is about tolerating a
        // command that RAN AND FAILED - a failed validation must always fail the
        // run. Having nothing to validate is not a failed validation. A real
        // feature-dev run died here: the requirement was already satisfied on
        // disk, the implement step correctly reported PRODUCED: nothing, and the
        // run was then marked FAILED at validate - reading as a broken run when
        // nothing was broken.
        step.output =
          "no changed files - nothing for this step to act on\n" +
          "[engine] skipped, not failed: an empty change set is not a validation failure";
        step.status = "skipped";
        return true;
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
          // a visual preview that cannot start (plugin missing, no display) is
          // not a reason to abandon a finished implementation
          if (def.optional) {
            step.output += `
[engine] this step is optional - the run continues.`;
            step.status = "skipped";
            return true;
          }
          return false;
        }
      }
      const cliOk = await spawnToStep(
        run,
        step,
        def.bin,
        args.map(winQuote),
        undefined,
        undefined,
        (def.timeoutMinutes ?? 15) * 60_000,
      );
      // An optional step is best-effort: it must not take the run down with it.
      // `optional` used to cover only "nothing to expand", so a command that
      // ran and failed still killed the run - which is how a retrieve of
      // not-yet-existing metadata ended a feature-dev run at step four.
      if (!cliOk && def.optional) {
        step.output +=
          `\n[engine] this step is optional - the run continues. Nothing here is ` +
          `required for the next step; read the output above if the result matters to you.`;
        step.status = "skipped";
        return true;
      }
      return cliOk;
    }
  }
}

/** Fill "{inputs.x}" and "{steps.id.output}" placeholders.
 *
 * A referenced step output is passed WHOLE - no cap. There used to be one, and
 * it kept biting: at 8,000 chars a 15-requirement design produced
 * 4-requirement documents, and raising it to 48,000 only moved the cliff (the
 * largest real design measured 40,728, so 85% of the budget was already gone).
 * Every agent step is a fresh CLI process, so nothing accumulates across steps
 * and there is no context pressure to spend a cap on. */
function template(text: string, run: RunState, docs?: Map<string, string>): string {
  return text
    // {runId} lets a workflow stamp its outputs, so running the same workflow
    // twice produces two designs instead of silently overwriting the first
    .replace(/\{runId\}/g, run.runId)
    .replace(/\{inputs\.([\w-]+)\}/g, (_, k) => String(run.inputs[k] ?? ""))
    .replace(/\{steps\.([\w-]+)\.output\}/g, (_, id) => {
      // A step that wrote a document is quoted BY that document. Callers that
      // cannot read files (artifact paths, titles) pass no map and get the
      // previous behaviour exactly.
      const doc = docs?.get(id);
      if (doc) return doc;
      const s = run.steps.find((x) => x.id === id);
      return s ? s.output : "";
    });
}

/** Load the documents a prompt's `{steps.x.output}` placeholders should resolve
 * to: for every step it quotes that wrote an artifact, that artifact. */
async function quotedDocs(run: RunState, text: string): Promise<Map<string, string>> {
  const docs = new Map<string, string>();
  for (const m of text.matchAll(/\{steps\.([\w-]+)\.output\}/g)) {
    const rel = run.steps.find((x) => x.id === m[1])?.artifact;
    if (!rel || docs.has(m[1])) continue;
    const abs = resolveInside(run.root, toPosix(rel));
    const body = abs ? await fs.readFile(abs, "utf8").catch(() => "") : "";
    if (body.trim()) docs.set(m[1], body);
  }
  return docs;
}

/** Parse a "FILES: a, b, c" line from agent output into run.affected -
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
      // file names can be agent-created - sanitize like any templated value
      for (const f of files.slice(0, 50)) out.push("--source-dir", cliSafe(f.file));
    } else if (a === "{affectedSourceDirs}") {
      // Only paths that EXIST locally. --source-dir refreshes a local copy, so
      // a component the design is about to CREATE has nothing to refresh: on an
      // empty project "create a Student object" named files that were not in the
      // org or on disk, sf errored on the missing path, and the run died at the
      // retrieve step before writing a line of metadata.
      const files = (run.affected ?? []).filter((f) => existsSync(path.join(run.root, f)));
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

/** Args pass through cmd.exe (shell:true resolves .cmd shims) - quote paths
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

function spawnToStep(
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
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "true" },
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

let persistChain = Promise.resolve();

/** Debounce window for the streaming hot path. */
const PERSIST_DEBOUNCE_MS = 250;
const pendingPersist = new Map<string, ReturnType<typeof setTimeout>>();

/** Audit write for the STREAMING path.
 *
 * persist() rewrites the entire run as pretty-printed json, and a step's stdout
 * arrives as hundreds of small chunks, so writing on every chunk costs O(n^2)
 * in the output size. That was survivable only because the output was capped at
 * 60k; with the cap raised to a runaway backstop it is not. Coalesce the chunk
 * writes and let the boundaries - step end, gate, status change - call persist()
 * directly, which also cancels anything pending here. */
function persistSoon(run: RunState) {
  if (pendingPersist.has(run.runId)) return;
  pendingPersist.set(
    run.runId,
    setTimeout(() => {
      pendingPersist.delete(run.runId);
      void persist(run);
    }, PERSIST_DEBOUNCE_MS),
  );
}

async function persist(run: RunState) {
  // a forced write supersedes any coalesced one still waiting
  const queued = pendingPersist.get(run.runId);
  if (queued) {
    clearTimeout(queued);
    pendingPersist.delete(run.runId);
  }
  // serialize writes; audit file lives with the project
  persistChain = persistChain.then(async () => {
    try {
      const dir = path.join(run.root, ".dhruva", "runs");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${run.runId}.json`), JSON.stringify(run, null, 2), "utf8");
    } catch {
      /* audit persistence is best-effort */
    }
  });
  await persistChain;
}
