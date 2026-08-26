import type { WorkflowDef } from "./schema";

/** Deterministic semantic validation of a workflow definition — beyond shape:
 * every reference must resolve, every step must have what it depends on, and
 * a real deploy must sit behind a human gate. Returns a list of human-readable
 * problems; empty = valid. Applied to every custom-workflow save and, in dev,
 * to the built-ins at load. */
export function checkWorkflowSemantics(def: WorkflowDef): string[] {
  const problems: string[] = [];
  const inputKeys = new Set(def.inputs.map((i) => i.key));
  const stepIds = def.steps.map((s) => s.id);

  const seenBefore = (idx: number, pred: (s: WorkflowDef["steps"][number]) => boolean) =>
    def.steps.slice(0, idx).some(pred);

  def.steps.forEach((s, idx) => {
    const texts: string[] = [];
    if (s.prompt) texts.push(s.prompt);
    if (s.message) texts.push(s.message);
    if (s.args) texts.push(...s.args);
    const joined = texts.join("\n");

    // {inputs.X} must be a declared input — including inside {opt:} / {flag:}
    for (const m of joined.matchAll(/\{inputs\.([\w-]+)\}/g)) {
      if (!inputKeys.has(m[1])) {
        problems.push(`step "${s.id}": references {inputs.${m[1]}} but no such input is declared`);
      }
    }
    for (const m of joined.matchAll(/\{(?:opt|flag):[\w-]+:inputs\.([\w-]+)\}/g)) {
      if (!inputKeys.has(m[1])) {
        problems.push(
          `step "${s.id}": opt/flag placeholder references input "${m[1]}" which is not declared`,
        );
      }
    }
    // {steps.Y.output} must reference an EARLIER step
    for (const m of joined.matchAll(/\{steps\.([\w-]+)\.output\}/g)) {
      const refIdx = stepIds.indexOf(m[1]);
      if (refIdx === -1) {
        problems.push(`step "${s.id}": references {steps.${m[1]}.output} but no such step exists`);
      } else if (refIdx >= idx) {
        problems.push(
          `step "${s.id}": references {steps.${m[1]}.output} but "${m[1]}" runs at or after it`,
        );
      }
    }
    // onlyIf must be a declared input
    if (s.onlyIf && !inputKeys.has(s.onlyIf)) {
      problems.push(`step "${s.id}": onlyIf "${s.onlyIf}" is not a declared input`);
    }
    // gate reviseTarget must be an earlier agent step
    if (s.type === "gate" && s.reviseTarget) {
      const t = stepIds.indexOf(s.reviseTarget);
      if (t === -1) {
        problems.push(`gate "${s.id}": reviseTarget "${s.reviseTarget}" does not exist`);
      } else if (t >= idx) {
        problems.push(`gate "${s.id}": reviseTarget "${s.reviseTarget}" must run before the gate`);
      } else if (def.steps[t].type !== "agent") {
        problems.push(`gate "${s.id}": reviseTarget "${s.reviseTarget}" must be an agent step`);
      }
    }
    // autoRevise target must be an EARLIER agent step, with a valid trigger
    if (s.type === "agent" && s.autoRevise) {
      const t = stepIds.indexOf(s.autoRevise.target);
      if (t === -1) {
        problems.push(`step "${s.id}": autoRevise target "${s.autoRevise.target}" does not exist`);
      } else if (t >= idx) {
        problems.push(`step "${s.id}": autoRevise target must run before it`);
      } else if (def.steps[t].type !== "agent") {
        problems.push(`step "${s.id}": autoRevise target must be an agent step`);
      }
      try {
        new RegExp(s.autoRevise.trigger);
      } catch {
        problems.push(`step "${s.id}": autoRevise trigger is not a valid regex`);
      }
    }
    // tasks-check and taskLoop need the tasks file path
    if (s.type === "tasks-check" && !s.tasksFile) {
      problems.push(`step "${s.id}": tasks-check requires tasksFile`);
    }
    if (s.taskLoop && !s.tasksFile) {
      problems.push(`step "${s.id}": taskLoop requires tasksFile`);
    }
    // expansion placeholders need their producers earlier in the flow
    if (s.args?.includes("{changedSourceDirs}") && !seenBefore(idx, (p) => p.type === "changes")) {
      problems.push(
        `step "${s.id}": uses {changedSourceDirs} but no "changes" step runs before it`,
      );
    }
    if (s.args?.includes("{affectedSourceDirs}") && !seenBefore(idx, (p) => p.type === "agent")) {
      problems.push(
        `step "${s.id}": uses {affectedSourceDirs} but no agent step runs before it to name files`,
      );
    }
    // changes/verify diff against a baseline — require a snapshot first
    if ((s.type === "changes" || s.type === "verify") && !seenBefore(idx, (p) => p.type === "snapshot")) {
      problems.push(`step "${s.id}" (${s.type}): needs a "snapshot" step earlier in the workflow`);
    }
    // a REAL deploy (sf project deploy start without --dry-run) must be gated
    if (
      s.type === "cli" &&
      s.bin === "sf" &&
      s.args &&
      s.args.join(" ").includes("deploy start") &&
      !s.args.includes("--dry-run") &&
      !seenBefore(idx, (p) => p.type === "gate")
    ) {
      problems.push(
        `step "${s.id}": deploys to the org with no human gate before it — add a gate step`,
      );
    }
  });

  return problems;
}
