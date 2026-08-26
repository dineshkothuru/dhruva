import type { WorkflowDef } from "../schema";

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
        "{opt:--tests:inputs.tests}", "--code-coverage", "--result-format", "json", "--json", "--wait", "60",
      ],
    },
  ],
};
