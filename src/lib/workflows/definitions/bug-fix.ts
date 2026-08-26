import type { WorkflowDef } from "../schema";

export const BUG_FIX: WorkflowDef = {
  id: "bug-fix",
  title: "Bug fix",
  description:
    "Locate the root cause, gate on the fix plan, implement, review the diff, validate and deploy the changed files.",
  inputs: [
    { key: "description", label: "Bug description", kind: "text", attachTo: true },
    { key: "runTests", label: "Run local Apex tests during validation", kind: "boolean", default: false },
    { key: "deploy", label: "Deploy to the default org at the end", kind: "boolean", default: true },
    {
      key: "visualTest",
      label: "Visual test before deploy (opens the org in the browser with your LOCAL UI files + live org data)",
      kind: "boolean",
      default: false,
    },
  ],
  steps: [
    { id: "snapshot", title: "Snapshot baseline", type: "snapshot" },
    {
      id: "locate",
      title: "Locate root cause (agent, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
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
      id: "verify-standards",
      title: "Verify standards on changed files (deterministic)",
      type: "verify",
    },
    {
      id: "review",
      title: "Code review of the changes (agent, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      persona: "salesforce-review",
      autoRevise: { target: "implement", trigger: "VERDICT:\\s*BLOCKED", maxRounds: 1 },
      prompt:
        "Review ONLY the changes listed below (made in this run) against the team standards. " +
        "Do not modify any files.\n" +
        "Changed files:\n{steps.changes.output}\n" +
        "Deterministic standards-check result:\n{steps.verify-standards.output}\n" +
        "Read each changed file, review the actual change, and end with exactly one line:\n" +
        "VERDICT: READY — or — VERDICT: BLOCKED, followed by the numbered blocking items.",
    },
    {
      id: "approve-changes",
      title: "Approve code changes",
      type: "gate",
      reviseTarget: "implement",
      message:
        "The files listed above were changed. Open the diffs from the run view; type instructions and Revise to have the fix reworked. Approve to validate against the org.",
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
      id: "visual-preview",
      title: "Visual test — local files against live org data (Local Dev)",
      type: "cli",
      bin: "sf",
      detached: true,
      onlyIf: "visualTest",
      args: ["lightning", "dev", "app"],
    },
    {
      id: "approve-deploy",
      title: "Approve deploy",
      type: "gate",
      onlyIf: "deploy",
      message:
        "Validation passed. If you enabled the visual test, click through the app in the browser first. Deploy the changed files to the default org now?",
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
