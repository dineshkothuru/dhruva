import type { WorkflowDef } from "../schema";

export const FEATURE_DEV: WorkflowDef = {
  id: "feature-dev",
  title: "Feature development",
  description:
    "Turn a requirement into a technical spec (gated), implement with tests, review the diff, validate and deploy.",
  inputs: [
    { key: "requirement", label: "Requirement / user story", kind: "text", attachTo: true },
    { key: "runTests", label: "Run local Apex tests during validation", kind: "boolean", default: true },
    { key: "deploy", label: "Deploy to the default org at the end", kind: "boolean", default: false },
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
      id: "spec",
      title: "Draft technical spec (agent, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      prompt:
        "You are designing a Salesforce implementation for a requirement. DO NOT modify any files in this step.\n" +
        "Requirement: {inputs.requirement}\n" +
        "Study the existing codebase first (reuse existing classes/objects/patterns — never plan a parallel " +
        "implementation of something that exists). Reply with a short technical spec: (1) approach, " +
        "(2) components to create or modify, (3) test plan.\n" +
        "End your reply with one line listing every EXISTING file you will modify as project-relative paths:\n" +
        "FILES: force-app/main/default/classes/Example.cls",
    },
    {
      id: "approve-spec",
      title: "Approve technical spec",
      type: "gate",
      message: "Review the technical spec above. Proceed with implementation?",
    },
    {
      id: "retrieve-fresh",
      title: "Retrieve fresh copies of files to be modified",
      type: "cli",
      bin: "sf",
      optional: true,
      args: ["project", "retrieve", "start", "{affectedSourceDirs}", "--json", "--wait", "10"],
    },
    { id: "retrieve-delta", title: "Compare retrieved files against spec-time versions", type: "changes" },
    { id: "rebaseline", title: "Re-baseline after org refresh", type: "snapshot" },
    {
      id: "implement",
      title: "Implement feature + tests (agent)",
      type: "agent",
      prompt:
        "Implement this feature in the current project.\n" +
        "Requirement: {inputs.requirement}\n" +
        "Approved technical spec:\n{steps.spec.output}\n\n" +
        "Org-refresh delta since the spec was written:\n{steps.retrieve-delta.output}\n" +
        "If files are listed in that delta, re-read them and adapt the spec before coding.\n" +
        "Write or update Apex tests for everything you implement (aim for the changed classes to be " +
        "covered). Follow the existing code style. Never create a parallel implementation of " +
        "something that already exists. Do not deploy.",
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
      prompt:
        "Review ONLY the changes listed below (made in this run) against the team standards. " +
        "Do not modify any files.\n" +
        "Changed files:\n{steps.changes.output}\n" +
        "Deterministic standards-check result:\n{steps.verify-standards.output}\n" +
        "Read each changed file, review the actual change, and end with the explicit verdict: " +
        "ready, or blocked with the specific blocking items.",
    },
    {
      id: "traceability",
      title: "Requirement coverage check (agent, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      prompt:
        "Coverage check. Re-read the full requirement (and any attached documents it references):\n" +
        "{inputs.requirement}\n" +
        "Extract every distinct requirement item, and for EACH one inspect the changed files below:\n" +
        "  <n>. <item> — IMPLEMENTED (evidence: file + method/element) | PARTIAL (what is missing) | MISSING\n" +
        "Changed files in this run:\n{steps.changes.output}\n" +
        "Do not modify any files. Be strict: no evidence in the diff = MISSING. End with the " +
        "verdict line: COVERAGE: COMPLETE, or COVERAGE: INCOMPLETE — items <numbers>.",
    },
    {
      id: "approve-changes",
      title: "Approve code changes",
      type: "gate",
      reviseTarget: "implement",
      message:
        "Review the diffs, the reviewer's verdict, and the coverage check above. If items are PARTIAL/MISSING, type e.g. 'implement items 2 and 5' and Revise. Approve to validate against the org.",
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
