import type { WorkflowDef } from "../schema";

export const DEPLOY_PREVIEW: WorkflowDef = {
  id: "deploy-preview",
  title: "Deploy preview",
  description:
    "Read-only: list exactly what a deploy from this folder would change in the org. Requires a SOURCE-TRACKED org (scratch org, or a Developer/Dev Pro sandbox with tracking enabled) — regular sandboxes fail with NonSourceTrackedOrgError; use Validate deploy there instead.",
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
