import type { WorkflowDef } from "../schema";

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
