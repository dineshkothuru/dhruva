import type { WorkflowDef } from "../schema";

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
