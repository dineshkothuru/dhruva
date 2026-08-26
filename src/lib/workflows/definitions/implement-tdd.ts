import type { WorkflowDef } from "../schema";

export const IMPLEMENT_TDD: WorkflowDef = {
  id: "implement-tdd",
  title: "Implement from TDD",
  description:
    "Build what an approved Technical Design Document specifies: plan gate, fresh org copies, implementation with tests, standards check, review, validate, deploy to the connected sandbox.",
  inputs: [
    {
      key: "tddPath",
      label: "TDD path in the project (e.g. docs/designs/solution-design-tdd.md)",
      kind: "text",
      default: "docs/designs/solution-design-tdd.md",
    },
    { key: "scope", label: "Scope note (optional — e.g. only components 1-3)", kind: "text", default: "", attachTo: true },
    { key: "runTests", label: "Run local Apex tests during validation", kind: "boolean", default: true },
    { key: "deploy", label: "Deploy to the connected sandbox at the end", kind: "boolean", default: true },
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
      id: "plan",
      title: "Read the TDD and plan the build (agent, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      prompt:
        "Read the approved Technical Design Document at {inputs.tddPath} in this project. " +
        "DO NOT modify any files in this step.\n" +
        "Scope note from the requester (may narrow the work): {inputs.scope}\n" +
        "Cross-check the TDD against the current codebase (components it references, reuse it " +
        "assumes). If the TDD has a Build Plan section (task table T-1, T-2… with depends_on), " +
        "use ITS order as the checklist; otherwise produce the implementation checklist in " +
        "dependency order yourself. Either way: each component to create or modify, and flag " +
        "anything in the TDD that no longer matches the codebase.\n" +
        "End with one line listing every EXISTING file you will modify as project-relative paths:\n" +
        "FILES: force-app/main/default/classes/Example.cls",
    },
    {
      id: "approve-plan",
      title: "Approve the build plan",
      type: "gate",
      message:
        "Review the implementation checklist above (revise with instructions if the order or scope needs changing). Proceed with the build?",
    },
    {
      id: "retrieve-fresh",
      title: "Retrieve fresh copies of files to be modified",
      type: "cli",
      bin: "sf",
      optional: true,
      args: ["project", "retrieve", "start", "{affectedSourceDirs}", "--json", "--wait", "10"],
    },
    { id: "retrieve-delta", title: "Compare retrieved files against plan-time versions", type: "changes" },
    { id: "rebaseline", title: "Re-baseline after org refresh", type: "snapshot" },
    {
      id: "implement",
      title: "Implement per TDD (agent)",
      type: "agent",
      prompt:
        "Implement the approved plan. The Technical Design Document at {inputs.tddPath} is the " +
        "specification — follow its component designs, API names, and test strategy exactly.\n" +
        "Approved build checklist:\n{steps.plan.output}\n\n" +
        "Org-refresh delta since planning:\n{steps.retrieve-delta.output}\n" +
        "If files are listed in that delta, re-read them before changing them.\n" +
        "Write or update the Apex tests the TDD's test strategy specifies. Never create a parallel " +
        "implementation of something that exists. Do not deploy.",
    },
    { id: "changes", title: "Collect changed files", type: "changes" },
    {
      id: "verify-standards",
      title: "Verify standards on changed files (deterministic)",
      type: "verify",
    },
    {
      id: "review",
      title: "Code review against the TDD (agent, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      persona: "salesforce-review",
      prompt:
        "Review ONLY the changes listed below against the team standards AND against the TDD at " +
        "{inputs.tddPath} (the changes must implement what the TDD specifies — flag deviations). " +
        "Do not modify any files.\n" +
        "Changed files:\n{steps.changes.output}\n" +
        "Deterministic standards-check result:\n{steps.verify-standards.output}\n" +
        "End with the explicit verdict: ready, or blocked with the specific blocking items.",
    },
    {
      id: "traceability",
      title: "Requirements traceability matrix (agent, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      prompt:
        "Build a requirements traceability matrix. Re-read the ENTIRE TDD at {inputs.tddPath} " +
        "(chunked reads to the end). Extract every requirement/component/behavior it specifies " +
        "(respect the scope note: {inputs.scope}). For EACH item, inspect the changed files below " +
        "and report one line:\n" +
        "  <n>. <requirement item> — IMPLEMENTED (evidence: file + method/element) | PARTIAL (what is missing) | MISSING\n" +
        "Changed files in this run:\n{steps.changes.output}\n" +
        "Do not modify any files. Be strict: no evidence in the diff = MISSING, even if it seems " +
        "implied. End with the verdict line: COVERAGE: COMPLETE, or COVERAGE: INCOMPLETE — items <numbers>.",
    },
    {
      id: "approve-changes",
      title: "Approve code changes",
      type: "gate",
      reviseTarget: "implement",
      message:
        "Review the diff, the reviewer's verdict, and the traceability matrix above. If items are PARTIAL/MISSING, type e.g. 'implement items 4 and 7' and Revise — the build re-runs and the matrix regenerates. Approve to validate against the org.",
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
      title: "Approve deploy to the connected sandbox",
      type: "gate",
      onlyIf: "deploy",
      message:
        "Validation passed. If you enabled the visual test, click through the app in the browser first. Deploy the changed files to the connected sandbox now?",
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
