import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot } from "@/lib/fsguard";
import { isAgentId } from "@/lib/agents";
import { isSafeModelId } from "@/lib/agents";
import { WORKFLOWS } from "@/lib/workflows/builtins";
import { getRun, listRuns, resolveGate, startRun } from "@/lib/workflows/engine";

/** Workflow control plane.
 * POST {action:"list"}                         → workflow catalog
 * POST {action:"start", root, workflow, inputs, agent, model} → {runId}
 * POST {action:"state", runId}                 → RunState (UI polls this)
 * POST {action:"runs", root}                   → recent runs for the project
 * POST {action:"gate", runId, approve}         → resolve a waiting gate */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (b.action === "list") {
    return NextResponse.json({
      workflows: Object.values(WORKFLOWS).map((w) => ({
        id: w.id,
        title: w.title,
        description: w.description,
        inputs: w.inputs,
      })),
    });
  }

  if (b.action === "state") {
    const run = typeof b.runId === "string" ? getRun(b.runId) : undefined;
    if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
    return NextResponse.json(run);
  }

  if (b.action === "gate") {
    if (typeof b.runId !== "string" || typeof b.approve !== "boolean") {
      return NextResponse.json({ error: "runId + approve required" }, { status: 400 });
    }
    const ok = resolveGate(b.runId, b.approve);
    return NextResponse.json({ resolved: ok });
  }

  // actions below need a validated project root
  const root = typeof b.root === "string" ? path.normalize(b.root.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }

  if (b.action === "runs") {
    return NextResponse.json({ runs: await listRuns(root) });
  }

  if (b.action === "start") {
    if (typeof b.workflow !== "string" || !WORKFLOWS[b.workflow]) {
      return NextResponse.json({ error: "unknown workflow" }, { status: 400 });
    }
    if (!isAgentId(b.agent)) {
      return NextResponse.json({ error: "unknown agent" }, { status: 400 });
    }
    const inputs =
      b.inputs && typeof b.inputs === "object" ? (b.inputs as Record<string, string | boolean>) : {};
    for (const [k, v] of Object.entries(inputs)) {
      if (typeof v !== "string" && typeof v !== "boolean") delete inputs[k];
      if (typeof v === "string" && v.length > 8000) inputs[k] = v.slice(0, 8000);
    }
    const model = isSafeModelId(b.model) ? b.model : undefined;
    const run = startRun(root, b.workflow, inputs, b.agent, model);
    if (!run) return NextResponse.json({ error: "could not start run" }, { status: 500 });
    return NextResponse.json({ runId: run.runId });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
