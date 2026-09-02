import type { StepDef, WorkflowDef } from "./schema";

const STEP_TYPES = new Set([
  "snapshot",
  "agent",
  "cli",
  "gate",
  "changes",
  "verify",
  "tasks-check",
  "work-check",
]);
const ROLES = new Set(["read", "design", "implement", "review", "trace"]);
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

/** Validate an untrusted definition into a clean WorkflowDef (or throw).
 * ONE validator for every source - shipped JSON files and user customs go
 * through the same contract, so the two can never drift apart.
 * reservedIds: ids the definition may not use (built-ins, for customs). */
export function validateWorkflowDef(raw: unknown, reservedIds?: Set<string>): WorkflowDef {
  const d = raw as Partial<WorkflowDef>;
  if (!d || typeof d !== "object") throw new Error("definition must be an object");
  if (typeof d.id !== "string" || !SLUG.test(d.id)) {
    throw new Error("id must be a lowercase slug (a-z, 0-9, dashes)");
  }
  if (reservedIds?.has(d.id)) throw new Error(`id "${d.id}" collides with a built-in workflow`);
  if (typeof d.title !== "string" || !d.title.trim() || d.title.length > 80) {
    throw new Error("title required (max 80 chars)");
  }
  const description = typeof d.description === "string" ? d.description.slice(0, 300) : "";

  const inputs = (Array.isArray(d.inputs) ? d.inputs : []).slice(0, 10).map((i) => {
    if (!i || typeof i.key !== "string" || !KEY.test(i.key)) throw new Error("bad input key");
    const kind: "text" | "boolean" | "select" =
      i.kind === "boolean" || i.kind === "select" ? i.kind : "text";
    return {
      key: i.key,
      label: typeof i.label === "string" ? i.label.slice(0, 200) : i.key,
      kind,
      options:
        kind === "select" && Array.isArray(i.options)
          ? i.options.filter((o) => typeof o === "string").slice(0, 12)
          : undefined,
      default:
        typeof i.default === "boolean" || typeof i.default === "string" ? i.default : undefined,
      attachTo: i.attachTo === true && kind === "text" ? true : undefined,
      hidden: i.hidden === true ? true : undefined,
    };
  });

  if (!Array.isArray(d.steps) || d.steps.length === 0 || d.steps.length > 30) {
    throw new Error("1-30 steps required");
  }
  const seen = new Set<string>();
  const steps: StepDef[] = d.steps.map((s) => {
    if (!s || typeof s.id !== "string" || !SLUG.test(s.id)) throw new Error("bad step id");
    if (seen.has(s.id)) throw new Error(`duplicate step id "${s.id}"`);
    seen.add(s.id);
    if (typeof s.type !== "string" || !STEP_TYPES.has(s.type)) {
      throw new Error(`bad step type on "${s.id}"`);
    }
    const step: StepDef = {
      id: s.id,
      title: typeof s.title === "string" && s.title.trim() ? s.title.slice(0, 160) : s.id,
      type: s.type as StepDef["type"],
    };
    if (s.type === "agent") {
      if (typeof s.prompt !== "string" || !s.prompt.trim()) {
        throw new Error(`agent step "${s.id}" needs a prompt`);
      }
      // no cap: a step prompt carries the task AND its output contract, and
      // silently trimming the tail of it drops the contract first
      step.prompt = s.prompt;
      if (s.readOnly === true) step.readOnly = true;
      if (s.orgAware === false) step.orgAware = false;
      if (typeof s.persona === "string" && SLUG.test(s.persona)) step.persona = s.persona;
      if (typeof s.role === "string" && ROLES.has(s.role)) {
        step.role = s.role as StepDef["role"];
      }
      if (s.autoRevise && typeof s.autoRevise === "object") {
        const a = s.autoRevise as { target?: unknown; trigger?: unknown; maxRounds?: unknown };
        if (
          typeof a.target === "string" &&
          SLUG.test(a.target) &&
          typeof a.trigger === "string" &&
          a.trigger.length <= 200
        ) {
          step.autoRevise = {
            target: a.target,
            trigger: a.trigger,
            maxRounds:
              typeof a.maxRounds === "number" ? Math.min(Math.max(a.maxRounds, 1), 10) : undefined,
          };
        }
      }
      if (s.taskLoop === true) step.taskLoop = true;
      if (typeof s.artifact === "string" && s.artifact.length <= 200 && !s.artifact.includes("..")) {
        step.artifact = s.artifact;
      }
      if (typeof s.reviewOf === "string" && SLUG.test(s.reviewOf)) step.reviewOf = s.reviewOf;
      if (s.emits === "findings" || s.emits === "coverage" || s.emits === "work") {
        step.emits = s.emits;
      }
    }
    if (s.type === "cli") {
      if (s.bin !== "sf" && s.bin !== "git") throw new Error(`cli step "${s.id}": bin must be sf or git`);
      if (!Array.isArray(s.args) || s.args.length === 0 || s.args.length > 40) {
        throw new Error(`cli step "${s.id}" needs 1-40 args`);
      }
      step.bin = s.bin;
      step.args = s.args.map((a) => {
        if (typeof a !== "string" || a.length > 300) throw new Error("bad cli arg");
        return a;
      });
      if (s.bin === "git") {
        // git carries option-level escape hatches that are arbitrary command
        // execution (-c core.fsmonitor=..., --exec-path, alias.x=!cmd), and a
        // project-scope workflow ships with the attacked repo itself - so git
        // steps are held to a plain-subcommand allowlist. No shipped step uses
        // git at all; only custom workflows are affected, which is the point.
        const GIT_SUBCOMMANDS = new Set([
          "status", "diff", "log", "show", "ls-files", "rev-parse", "blame",
          "shortlog", "describe", "add", "commit", "restore", "stash", "branch", "tag",
        ]);
        const GIT_FLAGS = new Set([
          "-m", "--stat", "--name-status", "--name-only", "--oneline",
          "--porcelain", "--cached", "--staged", "--no-color", "--all",
        ]);
        if (!GIT_SUBCOMMANDS.has(step.args[0])) {
          throw new Error(`cli step "${s.id}": git subcommand "${step.args[0]}" is not allowed`);
        }
        const bad = step.args.find((a, i) => i > 0 && a.startsWith("-") && !GIT_FLAGS.has(a));
        if (bad) throw new Error(`cli step "${s.id}": git option "${bad}" is not allowed`);
      }
      if (s.optional === true) step.optional = true;
      if (s.detached === true) step.detached = true;
    }
    if (s.type === "gate") {
      step.message =
        typeof s.message === "string" && s.message.trim() ? s.message : "Proceed?";
      if (typeof s.reviseTarget === "string" && SLUG.test(s.reviseTarget)) {
        step.reviseTarget = s.reviseTarget;
      }
    }
    if (typeof s.onlyIf === "string" && KEY.test(s.onlyIf)) step.onlyIf = s.onlyIf;
    if (typeof s.skipIf === "string" && KEY.test(s.skipIf)) step.skipIf = s.skipIf;
    if (typeof s.timeoutMinutes === "number") {
      step.timeoutMinutes = Math.min(Math.max(Math.round(s.timeoutMinutes), 1), 120);
    }
    if (typeof s.tasksFile === "string" && s.tasksFile.length <= 200 && !s.tasksFile.includes("..")) {
      step.tasksFile = s.tasksFile;
    }
    return step;
  });

  const def: WorkflowDef = { id: d.id, title: d.title.trim(), description, inputs, steps };
  const problems = checkWorkflowSemantics(def);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return def;
}

/** Deterministic semantic validation of a workflow definition - beyond shape:
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

    // {inputs.X} must be a declared input - including inside {opt:} / {flag:}
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
    // onlyIf / skipIf must be a declared input
    if (s.onlyIf && !inputKeys.has(s.onlyIf)) {
      problems.push(`step "${s.id}": onlyIf "${s.onlyIf}" is not a declared input`);
    }
    if (s.skipIf && !inputKeys.has(s.skipIf)) {
      problems.push(`step "${s.id}": skipIf "${s.skipIf}" is not a declared input`);
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
      // a step that drives a rework must declare what it emits, so the engine
      // can tell "found nothing" from "produced nothing parseable"
      if (!s.emits) {
        problems.push(
          `step "${s.id}": autoRevise needs an "emits" contract (findings | coverage)`,
        );
      }
    }
    // a reviewOf must name an EARLIER step that actually authors an artifact
    if (s.reviewOf) {
      const t = stepIds.indexOf(s.reviewOf);
      if (t === -1) {
        problems.push(`step "${s.id}": reviewOf "${s.reviewOf}" does not exist`);
      } else if (t >= idx) {
        problems.push(`step "${s.id}": reviewOf "${s.reviewOf}" must run before it`);
      } else if (!def.steps[t].artifact) {
        problems.push(
          `step "${s.id}": reviewOf "${s.reviewOf}" declares no artifact to write the review into`,
        );
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
    // changes/verify diff against a baseline - require a snapshot first
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
      // the guarding gate must be UNCONDITIONAL: a gate carrying onlyIf/skipIf
      // is skipped at runtime when its input is falsy, which would void the
      // very guarantee this rule exists to give
      !seenBefore(idx, (p) => p.type === "gate" && !p.onlyIf && !p.skipIf)
    ) {
      problems.push(
        `step "${s.id}": deploys to the org with no unconditional human gate before it - add a gate step (without onlyIf/skipIf)`,
      );
    }
  });

  return problems;
}
