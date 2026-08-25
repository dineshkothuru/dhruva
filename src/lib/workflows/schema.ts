/** Deterministic workflow engine — type definitions.
 *
 * A workflow is DATA (steps with dependencies); the engine is CODE. The only
 * nondeterministic step type is "agent" (one bounded task via the adapter
 * registry); every agent step is sandwiched between deterministic steps that
 * produce its input and verify its output. Gates pause for a human decision.
 */

import type { AgentId } from "@/lib/agents";

export type StepType = "snapshot" | "agent" | "cli" | "gate" | "changes" | "verify";

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
  /** gate: message template shown to the approver. */
  message?: string;
  /** Skip this step unless the named run input is truthy. */
  onlyIf?: string;
  /** cli: when an argv expansion has nothing to expand ({affectedSourceDirs}
   * with no files named), skip the step instead of failing the run. */
  optional?: boolean;
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
  inputs: Record<string, string | boolean>;
  steps: StepState[];
  /** Changed files as of the last "changes" step. */
  changes?: { file: string; status: string }[];
  /** Files the investigation step named (parsed from its FILES: line) —
   * used to retrieve fresh copies from the org before implementing. */
  affected?: string[];
}
