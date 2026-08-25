import type { WorkflowDef } from "./schema";

/** Built-in workflow library — ships with the harness so every team member
 * runs the same standard paths. (Project-custom workflows come later via
 * .sfharness/workflows/.) */

export const BUG_FIX: WorkflowDef = {
  id: "bug-fix",
  title: "Bug fix",
  description:
    "Locate the root cause, gate on the fix plan, implement, review the diff, validate and deploy the changed files.",
  inputs: [
    { key: "description", label: "Bug description", kind: "text" },
    { key: "runTests", label: "Run local Apex tests during validation", kind: "boolean", default: false },
    { key: "deploy", label: "Deploy to the default org at the end", kind: "boolean", default: true },
  ],
  steps: [
    { id: "snapshot", title: "Snapshot baseline", type: "snapshot" },
    {
      id: "locate",
      title: "Locate root cause (agent, read-only)",
      type: "agent",
      prompt:
        "You are investigating a bug. DO NOT modify any files in this step.\n" +
        "Bug report: {inputs.description}\n" +
        "Find the root cause in the local codebase. Reply with: (1) the root cause, " +
        "(2) the exact files involved, (3) a concrete fix plan. Keep it short.\n" +
        "End your reply with one line listing every involved file as project-relative paths:\n" +
        "FILES: force-app/main/default/classes/Example.cls, force-app/main/default/classes/ExampleTest.cls",
    },
    {
      id: "approve-plan",
      title: "Approve fix plan",
      type: "gate",
      message: "Review the root-cause analysis and fix plan above. Proceed with implementing it?",
    },
    {
      id: "retrieve-fresh",
      title: "Retrieve fresh copies of affected files from the org",
      type: "cli",
      bin: "sf",
      optional: true, // skip when the agent named no retrievable files
      args: ["project", "retrieve", "start", "{affectedSourceDirs}", "--json", "--wait", "10"],
    },
    {
      id: "retrieve-delta",
      title: "Compare retrieved files against the investigated versions",
      type: "changes",
    },
    {
      id: "rebaseline",
      title: "Re-baseline after org refresh",
      type: "snapshot",
    },
    {
      id: "implement",
      title: "Re-analyse fresh code if needed, then implement fix (agent)",
      type: "agent",
      prompt:
        "Implement the fix for this bug.\n" +
        "Bug report: {inputs.description}\n" +
        "Approved plan from the investigation step:\n{steps.locate.output}\n\n" +
        "The affected files were re-retrieved from the org after the investigation. This is the " +
        "exact delta between what the investigation saw and the org's current version:\n" +
        "{steps.retrieve-delta.output}\n" +
        "If that delta says 'no files changed', the plan is based on current code — implement it " +
        "directly. If files ARE listed, re-read those files first and re-verify the plan still " +
        "applies; if the fresh code already contains the fix or differs materially, adapt the " +
        "plan and say so.\n" +
        "Never create a new file, class, or method when an existing one should be edited — " +
        "search for existing implementations first and modify them. Only change what the plan " +
        "requires. Do not deploy.",
    },
    { id: "changes", title: "Collect changed files", type: "changes" },
    {
      id: "approve-changes",
      title: "Approve code changes",
      type: "gate",
      message:
        "The files listed above were changed. Open the diffs from the run view, then approve to validate against the org.",
    },
    {
      id: "validate",
      title: "Validate (check-only deploy of changed files)",
      type: "cli",
      bin: "sf",
      args: ["project", "deploy", "start", "--dry-run", "{changedSourceDirs}", "--json", "--wait", "30"],
    },
    {
      id: "validate-tests",
      title: "Validate with local tests",
      type: "cli",
      bin: "sf",
      onlyIf: "runTests",
      args: [
        "project", "deploy", "start", "--dry-run", "{changedSourceDirs}",
        "--test-level", "RunLocalTests", "--json", "--wait", "60",
      ],
    },
    {
      id: "approve-deploy",
      title: "Approve deploy",
      type: "gate",
      onlyIf: "deploy",
      message: "Validation passed. Deploy the changed files to the default org now?",
    },
    {
      id: "deploy",
      title: "Deploy changed files",
      type: "cli",
      bin: "sf",
      onlyIf: "deploy",
      args: ["project", "deploy", "start", "{changedSourceDirs}", "--json", "--wait", "30"],
    },
  ],
};

export const WORKFLOWS: Record<string, WorkflowDef> = {
  [BUG_FIX.id]: BUG_FIX,
};
