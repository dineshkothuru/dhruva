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

export const FEATURE_DEV: WorkflowDef = {
  id: "feature-dev",
  title: "Feature development",
  description:
    "Turn a requirement into a technical spec (gated), implement with tests, review the diff, validate and deploy.",
  inputs: [
    { key: "requirement", label: "Requirement / user story", kind: "text" },
    { key: "runTests", label: "Run local Apex tests during validation", kind: "boolean", default: true },
    { key: "deploy", label: "Deploy to the default org at the end", kind: "boolean", default: false },
  ],
  steps: [
    { id: "snapshot", title: "Snapshot baseline", type: "snapshot" },
    {
      id: "spec",
      title: "Draft technical spec (agent, read-only)",
      type: "agent",
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
      id: "approve-changes",
      title: "Approve code changes",
      type: "gate",
      message: "Review the changed files (open diffs from this run view). Validate against the org?",
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

export const RETRIEVE_SYNC: WorkflowDef = {
  id: "retrieve-sync",
  title: "Retrieve / org sync",
  description:
    "Pull the org's current metadata into the local folder and show exactly what drifted since the last local state.",
  inputs: [
    { key: "target", label: "Source path to sync (e.g. force-app)", kind: "text", default: "force-app" },
  ],
  steps: [
    { id: "snapshot", title: "Snapshot current local state", type: "snapshot" },
    {
      id: "retrieve",
      title: "Retrieve from org",
      type: "cli",
      bin: "sf",
      args: ["project", "retrieve", "start", "--source-dir", "{inputs.target}", "--json", "--wait", "60"],
    },
    { id: "drift", title: "Org drift vs previous local state", type: "changes" },
  ],
};

export const DEPLOY_PREVIEW: WorkflowDef = {
  id: "deploy-preview",
  title: "Deploy preview",
  description: "Read-only: list exactly what a deploy from this folder would change in the org.",
  inputs: [],
  steps: [
    {
      id: "preview",
      title: "Preview deploy against default org",
      type: "cli",
      bin: "sf",
      args: ["project", "deploy", "preview", "--json"],
    },
  ],
};

export const VALIDATE_DEPLOY: WorkflowDef = {
  id: "validate-deploy",
  title: "Validate deploy",
  description: "Preview, gate, then check-only deploy of a source path with the chosen test level.",
  inputs: [
    { key: "target", label: "Source path to validate", kind: "text", default: "force-app" },
    {
      key: "testLevel",
      label: "Test level",
      kind: "select",
      options: ["NoTestRun", "RunLocalTests", "RunAllTestsInOrg"],
      default: "RunLocalTests",
    },
  ],
  steps: [
    {
      id: "preview",
      title: "Preview what would change",
      type: "cli",
      bin: "sf",
      args: ["project", "deploy", "preview", "--source-dir", "{inputs.target}", "--json"],
    },
    {
      id: "approve",
      title: "Approve validation",
      type: "gate",
      message: "Review the preview above. Run the check-only deploy (nothing is saved to the org)?",
    },
    {
      id: "validate",
      title: "Check-only deploy",
      type: "cli",
      bin: "sf",
      args: [
        "project", "deploy", "start", "--dry-run", "--source-dir", "{inputs.target}",
        "--test-level", "{inputs.testLevel}", "--json", "--wait", "60",
      ],
    },
  ],
};

export const RUN_TESTS: WorkflowDef = {
  id: "run-tests",
  title: "Run Apex tests",
  description: "Run Apex tests in the default org with code coverage.",
  inputs: [
    {
      key: "level",
      label: "Test level",
      kind: "select",
      options: ["RunLocalTests", "RunAllTestsInOrg", "RunSpecifiedTests"],
      default: "RunLocalTests",
    },
    { key: "tests", label: "Class names (only for RunSpecifiedTests, comma-separated)", kind: "text", default: "" },
  ],
  steps: [
    {
      id: "run",
      title: "Run tests",
      type: "cli",
      bin: "sf",
      args: [
        "apex", "run", "test", "--test-level", "{inputs.level}",
        "{opt:--tests:inputs.tests}", "--code-coverage", "--result-format", "human", "--wait", "60",
      ],
    },
  ],
};

export const SCRATCH_ORG: WorkflowDef = {
  id: "scratch-org",
  title: "Scratch org from this folder",
  description:
    "Create a scratch org (needs an authorized Dev Hub), push this folder's source into it, and open it in the browser.",
  inputs: [
    { key: "alias", label: "Scratch org alias", kind: "text", default: "scratch1" },
    {
      key: "days",
      label: "Duration (days)",
      kind: "select",
      options: ["1", "7", "14", "30"],
      default: "7",
    },
  ],
  steps: [
    {
      id: "confirm",
      title: "Confirm scratch org creation",
      type: "gate",
      message:
        "This creates a scratch org from config/project-scratch-def.json (consumes one of your Dev Hub's daily scratch orgs) and pushes force-app into it. Proceed?",
    },
    {
      id: "create",
      title: "Create scratch org",
      type: "cli",
      bin: "sf",
      args: [
        "org", "create", "scratch", "--definition-file", "config/project-scratch-def.json",
        "--alias", "{inputs.alias}", "--duration-days", "{inputs.days}", "--json", "--wait", "20",
      ],
    },
    {
      id: "push",
      title: "Push local source into the scratch org",
      type: "cli",
      bin: "sf",
      args: [
        "project", "deploy", "start", "--source-dir", "force-app",
        "--target-org", "{inputs.alias}", "--json", "--wait", "60",
      ],
    },
    {
      id: "open",
      title: "Open the scratch org in the browser",
      type: "cli",
      bin: "sf",
      args: ["org", "open", "--target-org", "{inputs.alias}"],
    },
  ],
};

export const WORKFLOWS: Record<string, WorkflowDef> = {
  [BUG_FIX.id]: BUG_FIX,
  [FEATURE_DEV.id]: FEATURE_DEV,
  [RETRIEVE_SYNC.id]: RETRIEVE_SYNC,
  [DEPLOY_PREVIEW.id]: DEPLOY_PREVIEW,
  [VALIDATE_DEPLOY.id]: VALIDATE_DEPLOY,
  [RUN_TESTS.id]: RUN_TESTS,
  [SCRATCH_ORG.id]: SCRATCH_ORG,
};
