/** Deterministic workflow engine - type definitions.
 *
 * A workflow is DATA (steps with dependencies); the engine is CODE. The only
 * nondeterministic step type is "agent" (one bounded task via the adapter
 * registry); every agent step is sandwiched between deterministic steps that
 * produce its input and verify its output. Gates pause for a human decision.
 */

import type { AgentId } from "@/lib/agents";

/** The five model-consuming roles an agent step can play. Users pick models
 * ROLE-wise (5 decisions), not step-wise (17) - every step inherits from its
 * role; the tier map below is the shipped fallback per role. */
export type StepRole = "read" | "design" | "implement" | "review" | "trace";
export const STEP_ROLES: StepRole[] = ["read", "design", "implement", "review", "trace"];
export const ROLE_LABEL: Record<StepRole, string> = {
  read: "Read / investigate",
  design: "Design / author",
  implement: "Implement",
  review: "Review (critic)",
  trace: "Trace / coverage",
};
export const ROLE_TIER: Record<StepRole, "best" | "default" | "light"> = {
  read: "best",
  design: "default",
  implement: "default",
  review: "best",
  trace: "best",
};

export type StepType =
  | "snapshot"
  | "agent"
  | "cli"
  | "gate"
  | "changes"
  | "verify"
  | "tasks-check";

export interface StepDef {
  id: string;
  title: string;
  type: StepType;
  /** cli: argv AFTER the binary; binary must be in CLI_WHITELIST.
   * "{...}" placeholders are filled from run inputs / prior step outputs. */
  bin?: "sf" | "git";
  args?: string[];
  /** agent: prompt template ("{...}" placeholders allowed). */
  prompt?: string;
  /** agent: persona module from standards/personas (e.g. "salesforce-review")
   * whose body is prepended to the prompt as the step's role. */
  persona?: string;
  /** agent: enforce read-only at the CLI level (claude plan mode, codex
   * read-only sandbox, copilot tool denies) for investigate/review steps. */
  readOnly?: boolean;
  /** Step timeout in minutes (default 15). BRD-scale analysis and large
   * implementations legitimately need more. */
  timeoutMinutes?: number;
  /** agent: the step's role - the ONLY per-step model knob. Resolution:
   * the user's per-role model (run.roleModels) wins; otherwise the role's
   * tier (ROLE_TIER) resolves through the agent's shipped tiers map. */
  role?: StepRole;
  /** agent (review steps): bounded self-healing BEFORE the human gate. When
   * this step's output matches `trigger` (regex, case-insensitive), the
   * engine replays `target`..this step with the findings injected as
   * feedback, up to `maxRounds` times (default 1). The human gate always
   * follows - this only cleans what the human reviews, never replaces them. */
  autoRevise?: { target: string; trigger: string; maxRounds?: number };
  /** tasks-check / agent taskLoop / reviewer reopen: project-relative path
   * template of the machine-readable tasks file (JSON, see tasks.ts). */
  tasksFile?: string;
  /** agent: engine-driven task loop - one agent spawn per PENDING task in
   * tasksFile (dependency order); each success is marked completed with its
   * own token usage. Falls back to a normal single run when the file is
   * absent (older TDDs). */
  taskLoop?: boolean;
  /** gate: message template shown to the approver. */
  message?: string;
  /** gate: step id a "revise" decision replays from (default: the nearest
   * preceding agent step). Set to the implement step on code-review gates so
   * feedback reworks the code, not the read-only reviewer. */
  reviseTarget?: string;
  /** agent: project-relative path template of the FILE this step authors.
   * When set, the step's output is written there after a successful run and
   * survives a replay - which is what lets a rework read its own previous work
   * instead of redrafting from the requirement. */
  artifact?: string;
  /** agent: the machine-readable contract this step's output must satisfy.
   *
   * The engine appends the matching instruction (one source, next to the
   * parser that reads it) and then CHECKS the result: a step that declares a
   * contract and produces nothing parseable fails loudly instead of degrading
   * to a text slice, which is how a review yielding zero findings once fed a
   * rework 4,000 characters of terminal trace. */
  emits?: "findings" | "coverage";
  /** agent (review steps): the id of the step whose artifact this reviews.
   * The ENGINE writes the parsed findings into that file's "## Review"
   * section, so the reviewer itself stays readOnly and never gains write
   * access to the document it is judging. */
  reviewOf?: string;
  /** Skip this step unless the named run input is truthy. */
  onlyIf?: string;
  /** cli: when an argv expansion has nothing to expand ({affectedSourceDirs}
   * with no files named), skip the step instead of failing the run. */
  optional?: boolean;
  /** cli: launch in a visible console window and continue immediately -
   * for long-lived servers like Salesforce Local Dev (visual testing). */
  detached?: boolean;
}

export interface WorkflowDef {
  id: string;
  title: string;
  description: string;
  /** Inputs collected at start. */
  inputs: {
    key: string;
    label: string;
    kind: "text" | "boolean" | "select";
    options?: string[];
    default?: string | boolean;
    /** Attachment references are appended to THIS input (must be free-text,
     * never a path/list field). Fallback: the first text input. */
    attachTo?: boolean;
    /** Not shown in the start form - filled by the server from project
     * settings at run start (still recorded in the run's audited inputs). */
    hidden?: boolean;
  }[];
  steps: StepDef[];
}

export type StepStatus = "pending" | "running" | "waiting_gate" | "done" | "failed" | "skipped";

export interface StepState {
  id: string;
  title: string;
  type: StepType;
  status: StepStatus;
  /** Streamed/collected output shown in the UI (trimmed). */
  output: string;
  startedAt?: number;
  endedAt?: number;
  /** Agent steps: token usage + API-rate cost (exact when the vendor reports it). */
  usage?: { inTokens: number; outTokens: number; costUsd: number; estimated: boolean };
  /** Agent steps: the model this step actually ran with (role-resolved). */
  model?: string;
  /** Agent steps: WHERE the model came from, human-readable - 'your "review"
   * role setting' / 'shipped default for the "design" role' / 'run model' /
   * 'CLI default'. Shown in the UI and kept in the audit. */
  modelFrom?: string;
  /** changes steps: the shadow-git commit this step diffed the work tree
   * against. Pinned because the NEXT snapshot step moves HEAD past it - without
   * it, a drift report like retrieve-delta becomes unopenable minutes after it
   * is produced. */
  baseCommit?: string;
  /** EARLIER executions of this same step, oldest first.
   *
   * A step can run more than once: an auto-revise replays its target and the
   * reviewer that follows it, and a gate "revise" does the same. The replay
   * used to blank `output` and write over the fields above, so the run history
   * showed one row and the earlier attempt was simply gone - you could see that
   * a design had been reworked three times but never what any of them said.
   * Each replay now pushes the finished attempt here first, and the run history
   * renders one row per execution. */
  attempts?: StepAttempt[];
}

/** One finished execution of a step, kept when the step runs again. */
export interface StepAttempt {
  output: string;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  usage?: StepState["usage"];
  model?: string;
  /** why this attempt was superseded, e.g. "auto-revise round 1" */
  supersededBy?: string;
}

/** One link of a multi-workflow chain ("design and implement"): the workflow
 * to run, its prepared inputs, and - once started - its run id. */
export interface ChainLink {
  workflowId: string;
  title: string;
  inputs?: Record<string, string | boolean>;
  runId?: string;
}

export interface RunState {
  runId: string;
  workflowId: string;
  workflowTitle: string;
  root: string;
  createdAt: number;
  status: "running" | "waiting_gate" | "done" | "failed" | "aborted";
  agent: AgentId;
  model?: string;
  /** User-configured per-ROLE models for this run - the model setting.
   * A step's role model beats the shipped tier resolution. */
  roleModels?: Partial<Record<StepRole, string>>;
  inputs: Record<string, string | boolean>;
  steps: StepState[];
  /** Changed files as of the last "changes" step. */
  changes?: { file: string; status: string }[];
  /** Shadow-git commits pinning this run's before/after states - historical
   * runs stay diffable after later runs re-baseline HEAD. */
  baseCommit?: string;
  endCommit?: string;
  /** Files the investigation step named (parsed from its FILES: line) -
   * used to retrieve fresh copies from the org before implementing. */
  affected?: string[];
  /** Reviewer feedback given at gates, keyed by the agent step it revises -
   * injected into that step's prompt on re-run (and kept in the audit). */
  revisions?: Record<string, string[]>;
  /** Multi-workflow chain this run belongs to - the FULL ordered plan (links
   * up to chainIndex carry their runIds; the link AT chainIndex is this run).
   * When this run finishes with status done, the engine starts the next link
   * with the same agent/model settings. Fail/abort pauses the chain. */
  chain?: ChainLink[];
  chainIndex?: number;
  /** Auto-approve: EVERY gate in this run is approved without stopping, and
   * a chained phase inherits the flag. Deterministic - no model decides. Set
   * only by the user ticking the box on the chain proposal card. */
  autoGate?: boolean;
  /** Human-required actions the agents surfaced (parsed from their MANUAL:
   * lines - deterministic, zero tokens). Chained runs inherit the previous
   * phases' entries, so the LAST phase holds the full checklist. */
  manualSteps?: { stepId: string; phase?: string; text: string }[];
}

/** How a human resolved a gate. */
export interface GateDecision {
  action: "approve" | "abort" | "revise";
  feedback?: string;
}
