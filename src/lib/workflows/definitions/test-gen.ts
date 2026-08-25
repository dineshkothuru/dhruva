import type { WorkflowDef } from "../schema";

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
