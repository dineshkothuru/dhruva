import type { WorkflowDef } from "../schema";

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
