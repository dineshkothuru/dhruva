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
import { projectInventory } from "@/lib/projectInventory";
import { expandArgs, harvestAffectedFiles, quotedDocs, template, winQuote } from "./templating";
import { gateWaiters, hasActiveRun, persist, runs } from "./runStore";
import { makeClaudeTraceTransform, spawnToStep } from "./spawnStep";
import {
  blockedReviewBefore,
  contractHeld,
  READONLY_WROTE_MARK,
  recordRound,
} from "./reviewFold";
import {
  adoptArtifact,
  applyCards,
  designDocumentBlock,
  designStateBlock,
  designText,
  isDesignArtifact,
  nearestAgentIndex,
  parkAtGate,
  recordDecision,
  writePlainArtifact,
} from "./designGlue";

// The run registry moved to runStore.ts; the public API stays importable from
// the engine so no caller changes.
export {
  abortRun,
  getRun,
  hasActiveRun,
  listRuns,
  pendingGateCount,
  resolveGate,
} from "./runStore";
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
import { designFromOutput, extractDelta, madeProgress, type ReviewRecord } from "./artifacts";
import {
  decisionsOpen,
  fixableOpen,
  load as loadDesignDoc,
  writeUpdate as writeDesignUpdate,
} from "./designDoc";
import { checkEvidence, evidenceNote } from "./evidenceCheck";
import { GIT_FLAGS } from "./validate";
import { costBucket, countBucket, durationBucket, tokensBucket, track } from "@/lib/telemetry";
import type { ChainLink, GateDecision, RunState, StepDef, StepState, WorkflowDef } from "./schema";
import { ROLE_TIER } from "./schema";

/** Deterministic workflow runner. Runs live in this server process (a local
 * single-user tool); every state change is persisted to
 * <project>/.dhruva/runs/<runId>.json - the audit trail. */



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
  // Ambient-instruction check: agent CLIs run with cwd = this project, so any
  // vendor instruction files IN the project (CLAUDE.md, AGENTS.md, Copilot
  // instructions, skills) load into every agent step alongside the engine's
  // injected standards. That is both a duplicate/contradictory-standards risk
  // and a prompt-injection surface on a repo the user did not write. Surfaced
  // on the first step so the human sees it before approving anything.
  {
    const ambient = [
      "CLAUDE.md",
      "AGENTS.md",
      path.join(".github", "copilot-instructions.md"),
      path.join(".github", "instructions"),
      path.join(".claude", "skills"),
      path.join(".cursor", "rules"),
    ].filter((p) => existsSync(path.join(root, p)));
    if (ambient.length) {
      // Stored on the RUN and rendered into every gate message - a note
      // written into step[0].output alone was overwritten the moment that
      // step executed, so no human ever saw it.
      run.ambientWarning =
        `[engine] this project carries its own agent instruction files (${ambient.join(", ")}). ` +
        `Agent CLIs load them ambiently in addition to the engine's standards - review them ` +
        `before trusting this run's agent steps: instructions in a repo are input to the agent.`;
      if (run.steps[0]) run.steps[0].output = run.ambientWarning + "\n";
    }
  }
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

/** The ambient-instruction warning, rendered wherever a human decides. */
function ambientNote(run: RunState): string {
  return run.ambientWarning ? `\n\n${run.ambientWarning}` : "";
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
  // One project, one run - the same invariant startRun enforces. Resuming an
  // old run while another is live would put two executors on one working tree
  // and one shadow store, corrupting both runs' baselines.
  if (hasActiveRun(root)) return null;
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
  // Re-check after the awaits above: two concurrent resume calls both pass
  // the guards before either registers, so the second must lose here.
  if (hasActiveRun(root)) return null;
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
          step.output = template(stepDef.message ?? "Proceed?", run) + notice + ambientNote(run);
          notice = "";
          decision = { action: "approve" };
        } else {
          step.status = "waiting_gate";
          step.startedAt ??= Date.now();
          step.output = template(stepDef.message ?? "Proceed?", run) + notice + ambientNote(run);
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
        // Per-requirement rulings, when the human judged the cards one by one.
        // Applied BEFORE the action is acted on, because they decide what the
        // action means: cards sent back turn an approve into a partial revise,
        // and cards approved are frozen so that revise cannot touch them.
        const cards = await applyCards(run, def, i, decision.cards ?? []);
        if (cards.approved.length) {
          step.output += `\n→ approved ${cards.approved.length}: ${cards.approved.join(", ")}`;
        }
        if (cards.revising.length) {
          step.output += `\n→ sent back ${cards.revising.length}: ${cards.revising.join(", ")}`;
        }
        // A card sent back is a revision even when the button said approve -
        // the human's marks are the more specific instruction.
        const action = cards.revising.length > 0 ? "revise" : decision.action;
        const feedback = [decision.feedback?.trim(), cards.instruction].filter(Boolean).join("\n\n");
        if (action === "approve") {
          run.status = "running";
          step.output += auto ? "\n→ approved automatically (gates set to auto-approve)" : "\n→ approved";
          await recordDecision(
            run,
            def,
            i,
            "approved",
            feedback ||
              (auto ? "Approved automatically (gates set to auto-approve)." : "Approved as it stands."),
            // Freezing every block is right for a blanket approval and wrong
            // when the human signed specific cards: the ones they did not sign
            // are not approved, and stamping them would say they were.
            !auto && cards.approved.length === 0,
          );
          step.status = "done";
          step.endedAt = Date.now();
          await persist(run);
          break;
        }
        // Set aside what is blocked on a human and carry on with the rest.
        // Five unanswered questions should not hold an otherwise finished epic.
        if (action === "park") {
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
        if (action === "abort" || !feedback.trim()) {
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
        (run.revisions[targetId] ??= []).push(feedback);
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
              `"${feedback}". Do not re-raise what it settles.`,
          );
        }
        await recordDecision(run, def, i, "revise", feedback);
        step.output += `\n→ revision requested: ${feedback.slice(0, 300)}`;
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
      // A reviewer paired to an artifact records its round on EVERY execution
      // path. The fold used to live only inside the autoRevise branch, so a
      // reviewOf step WITHOUT autoRevise never wrote its findings into the
      // design register - despite schema.ts promising the engine records them.
      // (autoRevise steps record inside their own loop below, final round
      // included - this must not double-record them.)
      if (stepDef.type === "agent" && stepDef.reviewOf && !stepDef.autoRevise) {
        const rel = def.steps.find((s) => s.id === stepDef.reviewOf)?.artifact;
        if (rel) {
          const round = (step.attempts?.length ?? 0) + 1;
          await recordRound(run, template(rel, run).replace(/\\/g, "/"), step.output, round, step);
        }
      }
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
          // trigger tested against the TAIL only: the verdict lives at the end
          // of the output, and a workflow-authored regex against a 5MB string
          // is a ReDoS waiting to happen
          re && from >= 0 && from < i && round <= max && !stalled && re.test(step.output.slice(-100_000));
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
    // skipIf mirrors the main loop EXACTLY: a step the user satisfied with
    // their own document must not be re-run by a revision (the replay would
    // re-extract and overwrite the file they asked to keep) - but only when
    // the adoption is actually honourable. If the supplied document cannot be
    // adopted (wrong shape, unreadable), the step originally RAN, and a
    // revision must re-run it or the reviewer's feedback is silently dropped.
    if (replayDef.skipIf && String(run.inputs[replayDef.skipIf] ?? "").trim()) {
      const adopted = await adoptArtifact(run, replayDef, String(run.inputs[replayDef.skipIf]));
      if (adopted.ok) continue;
    }
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
    // A gate-revise replay re-runs the reviewer, and without this fold the
    // fresh round's findings never reached the design register - the gate
    // cards the human was about to sign still showed the PREVIOUS round's
    // states. Auto-revise replays skip it: that loop records its own rounds.
    if (
      replayDef.type === "agent" &&
      replayDef.reviewOf &&
      !reason.startsWith("auto-revise") &&
      replayStep.output
    ) {
      const rel = def.steps.find((s) => s.id === replayDef.reviewOf)?.artifact;
      if (rel) {
        const round = (replayStep.attempts?.length ?? 0) + 1;
        await recordRound(
          run,
          template(rel, run).replace(/\\/g, "/"),
          replayStep.output,
          round,
          replayStep,
        );
      }
    }
    await persist(run);
  }
  return true;
}

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

/** Run a step and, when it declares one, write its artifact.
 *
 * This wrapper exists because there are TWO paths into a step: the executor's
 * main loop and replayRange, which a rework uses. Putting the artifact write in
 * the main loop alone meant the revised design was never written back - the
 * reviewer would have re-read the FIRST design on every round, which is exactly
 * the bug this whole change is meant to remove. Every path goes through here. */

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
      // Only the DESIGN is state the engine owns. Every other artifact step is
      // a document its author writes once, and running one through the design
      // store re-renders it from a structure it was never meant to be: the
      // requirements step had 68 lines of `OPEN FINDINGS: -` and `STATE: open`
      // injected into the frozen list it had just written, and its sidecars -
      // findings.md, design-history.md - were written under the design's own
      // fixed names, to be clobbered minutes later by the real ones.
      if (!isDesignArtifact(rel)) {
        await writePlainArtifact(run.root, rel, design);
        step.artifact = rel;
        await persist(run);
        return true;
      }
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
      const wholeAbs = resolveInside(run.root, rel);
      const whole = wholeAbs
        ? await fs.readFile(wholeAbs, "utf8").catch(() => design)
        : design;
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
        ? changes
            .slice(0, 200)
            .map((c) => `${c.status.padEnd(8)} ${c.file}`)
            .join("\n") +
          (changes.length > 200
            ? `\n[engine] ...and ${changes.length - 200} more file(s) - the full list is tracked; only the display is capped`
            : "")
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
      const rules =
        (await standardsFor(scopeFiles, run.root, def.role).catch(() => "")) || STANDARDS_PROMPT;
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
      // Investigation and design steps get the project inventory: "does this
      // object have a trigger" answered by engine-parsed ground truth instead
      // of by how well the agent happens to search (a trigger's NAME says
      // nothing about its object). Implement/review steps skip it - their
      // scope arrives via the plan and the change list.
      const inventory =
        def.role === "read" || def.role === "design"
          ? await projectInventory(run.root).catch(() => "")
          : "";
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
        inventory +
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
            // per-task harvest over THIS task's output segment, merged - one
            // harvest over the cumulative output kept only one task's FILES:
            harvestAffectedFiles(run, step.output.slice(outStart), true);
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
          // (files were harvested per task above - a whole-output harvest here
          // would REPLACE the union with the last task's line)
          return true;
        }
        step.output += `[engine] no valid tasks file or nothing pending (${rel}) - running as a single step\n`;
      }

      // readOnly is STRUCTURAL for claude (plan mode) and codex (OS sandbox) -
      // those two cannot write no matter what, so fingerprinting them costs
      // two full git diffs per review to catch only the USER's own edits, a
      // false positive. Copilot (deny flags) and cursor (omitted --force) are
      // best-effort, so their trust IS verified: fingerprint the change list
      // around the step; a delta in EITHER direction (a write, or a revert of
      // the implement step's work) forfeits the review's gating power (see
      // blockedReviewBefore). An unknown fingerprint (git unavailable) proves
      // nothing and must not brand an honest review a violator.
      const verifyReadOnly =
        def.readOnly === true && (run.agent === "copilot" || run.agent === "cursor");
      const preReadOnly = verifyReadOnly ? await changesSince(run.root, run.baseCommit) : null;
      const ok = await spawnAgent(prompt, def.id);
      if (verifyReadOnly && preReadOnly !== null) {
        const post = await changesSince(run.root, run.baseCommit);
        if (post !== null) {
          const fp = (l: { file: string; status: string }[]) =>
            new Set(l.map((c) => `${c.status}:${c.file}`));
          const before = fp(preReadOnly);
          const after = fp(post);
          const delta = [
            ...[...after].filter((k) => !before.has(k)),
            ...[...before].filter((k) => !after.has(k)).map((k) => `reverted ${k}`),
          ];
          if (delta.length > 0) {
            step.output +=
              `\n${READONLY_WROTE_MARK} this step ran read-only but the working tree changed ` +
              `during it (${delta.slice(0, 10).join(", ")}${delta.length > 10 ? ", ..." : ""}). ` +
              `Its conclusions cannot be trusted to gate anything - review the files before approving.`;
          }
        }
      }
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
      // bounded read: checking is cheap but reading 30k retrieved files into
      // memory is not - the cap is raised well above real change-set sizes and
      // said OUT LOUD below when it trips, never silently
      const VERIFY_CAP = 500;
      for (const c of changed.slice(0, VERIFY_CAP)) {
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
      const unchecked =
        changed.length > VERIFY_CAP
          ? `\n[engine] NOTE: only the first ${VERIFY_CAP} of ${changed.length} changed files ` +
            `were content-checked - the remainder is unverified by this step.`
          : "";
      if (violations.length === 0) {
        step.output = `standards check passed (${contents.length} file(s))${unchecked}`;
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
      step.output += "\n\nwarnings only - review them at the next gate." + unchecked;
      return true;
    }
    case "cli": {
      if (def.bin !== "sf" && def.bin !== "git") {
        step.output = `binary not whitelisted: ${def.bin}`;
        return false;
      }
      const args = expandArgs(def.args ?? [], run);
      // Validation approved the UNexpanded args - re-check the rules that
      // template expansion could launder past it (an input value turning a
      // benign sf command into a real deploy, or smuggling option args into
      // git, where -c amounts to arbitrary command execution). Thrown, not
      // returned: the executor's catch fails the step, and a refusal must stay
      // distinguishable from the no-work skip below, which has its own
      // contract (see optionalCli.test.ts).
      if (args) {
        const realDeploy = (a: string[]) =>
          a.join(" ").includes("deploy start") && !a.includes("--dry-run");
        if (def.bin === "sf" && realDeploy(args) && !realDeploy(def.args ?? [])) {
          throw new Error(
            "expanded args formed a real deploy the workflow definition never declared - " +
              "refused (the deploy-needs-a-gate rule was validated against the unexpanded args)",
          );
        }
        if (def.bin === "git") {
          // an expanded option is fine if the validator would have allowed it
          // written literally ({flag:--stat:...} must not fail at runtime);
          // anything outside both the definition and the allowlist is smuggled
          const literal = new Set(def.args ?? []);
          const smuggled = args.find(
            (a) => a.startsWith("-") && !literal.has(a) && !GIT_FLAGS.has(a),
          );
          if (smuggled) {
            throw new Error(
              `expanded git option "${smuggled}" is not in the workflow definition - refused`,
            );
          }
        }
      }
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


