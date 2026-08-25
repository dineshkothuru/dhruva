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

export const SOLUTION_DESIGN: WorkflowDef = {
  id: "solution-design",
  title: "Solution design",
  description:
    "Architect path: analyse a requirement against the existing codebase, gate on the proposed design, then produce HLD + TDD documents (with an ERD) in the project.",
  inputs: [
    {
      key: "requirement",
      label: "Requirement (paste the text; attach documents via chat intake)",
      kind: "text",
    },
    { key: "docName", label: "Design document name (file-safe)", kind: "text", default: "solution-design" },
  ],
  steps: [
    { id: "snapshot", title: "Snapshot baseline", type: "snapshot" },
    {
      id: "analyse",
      title: "Analyse requirement against the codebase (architect, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      persona: "salesforce-architect",
      prompt:
        "A requirement needs a solution design for THIS org's codebase. DO NOT modify any files in this step.\n" +
        "Requirement:\n{inputs.requirement}\n\n" +
        "If the requirement references attached documents (paths under .sfharness/attachments/), " +
        "read EVERY attached document in full — every page/line, continuing in chunks until the end " +
        "of each file — before designing anything. A design based on a partially read requirement " +
        "is invalid.\n\n" +
        "Study the existing codebase first: objects, automation, apex services, LWCs that this " +
        "requirement touches. Then propose the design as a structured summary:\n" +
        "1. Solution overview and approach (declarative vs code, and why)\n" +
        "2. Data model: new/changed objects and fields, relationships\n" +
        "3. Components: apex classes, triggers, LWCs, flows to create or modify (name existing ones to reuse)\n" +
        "4. Security: sharing, profiles/permission sets, FLS\n" +
        "5. Impact analysis: existing behavior at risk\n" +
        "6. Risks, assumptions, and open questions\n" +
        "7. Rough effort estimate per component\n" +
        "Keep it reviewable — this summary is what the architect approves before the document is written.",
    },
    {
      id: "approve-design",
      title: "Approve the proposed design",
      type: "gate",
      message:
        "Review the proposed solution design above. On approval the full design document (including the ERD) is written into docs/designs/ in the project.",
    },
    {
      id: "write-doc",
      title: "Write HLD + TDD documents (with ERD)",
      type: "agent",
      prompt:
        "Write the APPROVED solution design as TWO Markdown documents (create folders if needed). " +
        "These two files are the only ones you may create or modify in this step:\n\n" +
        "1. docs/designs/{inputs.docName}-hld.md — HIGH-LEVEL DESIGN, written for stakeholders and " +
        "review boards: requirement summary, business context, solution overview and approach " +
        "(declarative vs code and why), architecture at component-group level, data model section " +
        "with a Mermaid er-diagram code block (```mermaid / erDiagram) of new and impacted objects " +
        "with relationships and key fields, integration touchpoints, security model overview, " +
        "impact analysis, risks/assumptions/open questions, effort estimate table.\n\n" +
        "2. docs/designs/{inputs.docName}-tdd.md — TECHNICAL DESIGN DOCUMENT, written for the " +
        "developers who will build it: per component (each apex class, trigger, LWC, flow, object/" +
        "field) — exact API names, purpose, reuse-vs-new decision, method-level design or flow " +
        "outline, key logic/pseudocode where non-trivial, error handling, governor-limit " +
        "considerations, sharing/FLS specifics, deployment order and dependencies, and a test " +
        "strategy section with the test classes/scenarios to write (positive/negative/bulk).\n\n" +
        "Approved design from the analysis step:\n{steps.analyse.output}\n\n" +
        "Incorporate every detail from the approved design; expand where precision is needed but " +
        "do not contradict what was approved. Cross-link the two documents at the top of each.",
    },
    { id: "changes", title: "Collect created documents", type: "changes" },
    {
      id: "approve-doc",
      title: "Accept the design document",
      type: "gate",
      message:
        "HLD and TDD are written (open them from the changed-files list or the file tree under docs/designs/). Accept to complete the run.",
    },
  ],
};

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
    { key: "scope", label: "Scope note (optional — e.g. only components 1-3)", kind: "text", default: "" },
    { key: "runTests", label: "Run local Apex tests during validation", kind: "boolean", default: true },
    { key: "deploy", label: "Deploy to the connected sandbox at the end", kind: "boolean", default: true },
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
        "assumes). Produce the implementation checklist in dependency order: each component to " +
        "create or modify, and flag anything in the TDD that no longer matches the codebase.\n" +
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
      id: "approve-deploy",
      title: "Approve deploy to the connected sandbox",
      type: "gate",
      onlyIf: "deploy",
      message: "Validation passed. Deploy the changed files to the connected sandbox now?",
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

export const TEST_GEN: WorkflowDef = {
  id: "test-gen",
  title: "Test generation",
  description:
    "Add meaningful Apex tests to existing code: assess coverage gaps for the target classes, gate on the test plan, write the tests, validate with local tests, deploy to the sandbox.",
  inputs: [
    {
      key: "target",
      label: "Target classes (comma-separated names, or describe the area)",
      kind: "text",
    },
    { key: "deploy", label: "Deploy the new tests to the connected sandbox", kind: "boolean", default: true },
  ],
  steps: [
    { id: "snapshot", title: "Snapshot baseline", type: "snapshot" },
    {
      id: "assess",
      title: "Assess coverage gaps (agent, read-only)",
      type: "agent",
      modelTier: "best",
      readOnly: true,
      persona: "salesforce-test",
      prompt:
        "Target: {inputs.target}\n" +
        "Read the target classes IN FULL and their existing test classes (if any). DO NOT modify " +
        "any files in this step. Identify the untested or weakly tested behavior: public methods, " +
        "branches, error paths, bulk behavior, permission-sensitive logic. Propose a test plan: " +
        "which test classes to create or extend, and the scenarios per class " +
        "(positive / negative / bulk / permission). Note whether a shared TestDataFactory exists " +
        "and what it is missing.\n" +
        "End with one line listing every EXISTING file you will modify as project-relative paths:\n" +
        "FILES: force-app/main/default/classes/ExampleTest.cls",
    },
    {
      id: "approve-plan",
      title: "Approve the test plan",
      type: "gate",
      message:
        "Review the coverage assessment and test plan (revise with instructions to change scope or scenarios). Proceed with writing the tests?",
    },
    {
      id: "implement",
      title: "Write the tests (agent)",
      type: "agent",
      prompt:
        "Write the tests per the approved plan:\n{steps.assess.output}\n\n" +
        "Rules of engagement: modify/create TEST classes (and the shared TestDataFactory if " +
        "needed) ONLY — never change the production classes under test in this workflow; if a " +
        "class is untestable as written, report it instead of changing it. Follow the apex-tests " +
        "standards: TestDataFactory data, Assert class with messages, positive/negative/bulk, " +
        "System.runAs with permission sets, no SeeAllData. Meaningful assertions over coverage " +
        "percentage.",
    },
    { id: "changes", title: "Collect changed files", type: "changes" },
    {
      id: "verify-standards",
      title: "Verify standards on changed files (deterministic)",
      type: "verify",
    },
    {
      id: "approve-changes",
      title: "Approve the new tests",
      type: "gate",
      reviseTarget: "implement",
      message:
        "Review the test diffs (links above); type instructions and Revise to rework them. Validate them against the org?",
    },
    {
      id: "validate",
      title: "Validate with local tests (proves the new tests pass)",
      type: "cli",
      bin: "sf",
      args: [
        "project", "deploy", "start", "--dry-run", "{changedSourceDirs}",
        "--test-level", "RunLocalTests", "--json", "--wait", "60",
      ],
    },
    {
      id: "approve-deploy",
      title: "Approve deploy to the connected sandbox",
      type: "gate",
      onlyIf: "deploy",
      message: "Tests validated. Deploy them to the connected sandbox?",
    },
    {
      id: "deploy",
      title: "Deploy the tests",
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
  [SOLUTION_DESIGN.id]: SOLUTION_DESIGN,
  [IMPLEMENT_TDD.id]: IMPLEMENT_TDD,
  [TEST_GEN.id]: TEST_GEN,
  [RETRIEVE_SYNC.id]: RETRIEVE_SYNC,
  [DEPLOY_PREVIEW.id]: DEPLOY_PREVIEW,
  [VALIDATE_DEPLOY.id]: VALIDATE_DEPLOY,
  [RUN_TESTS.id]: RUN_TESTS,
  [SCRATCH_ORG.id]: SCRATCH_ORG,
};
