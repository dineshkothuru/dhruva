import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot } from "@/lib/fsguard";
import { isAgentId } from "@/lib/agents";
import { isSafeModelId } from "@/lib/agents";
import { builtinWorkflows } from "@/lib/workflows/builtins";
import { STEP_ROLES, type StepRole } from "@/lib/workflows/schema";
import { readProjectSettings } from "@/lib/projectSettings";
import {
  deleteCustomWorkflow,
  listCustomWorkflows,
  loadWorkflow,
  saveCustomWorkflow,
} from "@/lib/workflows/custom";
import {
  abortRun,
  getRun,
  listRuns,
  pendingGateCount,
  resolveGate,
  startRun,
} from "@/lib/workflows/engine";

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
    const listRoot = typeof b.root === "string" ? path.normalize(b.root.trim()) : "";
    const customs =
      listRoot && (await isAttachableRoot(listRoot)) ? await listCustomWorkflows(listRoot) : [];
    let builtins;
    try {
      builtins = await builtinWorkflows();
    } catch (e) {
      return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
    }
    return NextResponse.json({
      workflows: [
        ...Object.values(builtins).map((w) => ({
          id: w.id,
          title: w.title,
          description: w.description,
          inputs: w.inputs,
          steps: w.steps,
          custom: false,
        })),
        ...customs.map(({ def: w, scope }) => ({
          id: w.id,
          title: w.title,
          description: w.description,
          inputs: w.inputs,
          steps: w.steps,
          custom: true,
          scope,
        })),
      ],
    });
  }

  if (b.action === "state") {
    const run = typeof b.runId === "string" ? getRun(b.runId) : undefined;
    if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
    return NextResponse.json(run);
  }

  if (b.action === "stop") {
    if (typeof b.runId !== "string") {
      return NextResponse.json({ error: "runId required" }, { status: 400 });
    }
    return NextResponse.json({ stopped: abortRun(b.runId) });
  }

  if (b.action === "gate") {
    const decision = b.decision;
    if (
      typeof b.runId !== "string" ||
      (decision !== "approve" && decision !== "abort" && decision !== "revise")
    ) {
      return NextResponse.json(
        { error: "runId + decision (approve|abort|revise) required" },
        { status: 400 },
      );
    }
    const feedback =
      typeof b.feedback === "string" ? b.feedback.trim().slice(0, 4000) : undefined;
    if (decision === "revise" && !feedback) {
      return NextResponse.json({ error: "revise requires feedback text" }, { status: 400 });
    }
    const ok = resolveGate(b.runId, { action: decision, feedback });
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

  if (b.action === "pending") {
    return NextResponse.json({ pendingGates: pendingGateCount(root) });
  }

  if (b.action === "save-custom") {
    try {
      const scope = b.scope === "project" ? "project" : "central";
      const def = await saveCustomWorkflow(root, b.def, scope);
      return NextResponse.json({ saved: def.id, scope });
    } catch (e) {
      return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
    }
  }

  if (b.action === "delete-custom") {
    if (typeof b.workflow !== "string") {
      return NextResponse.json({ error: "workflow id required" }, { status: 400 });
    }
    return NextResponse.json({ deleted: await deleteCustomWorkflow(root, b.workflow) });
  }

  if (b.action === "start") {
    const def = typeof b.workflow === "string" ? await loadWorkflow(root, b.workflow) : null;
    if (!def) {
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
    // Project-settings injection: when the workflow declares the UX inputs,
    // fill them from .sfharness/settings.json — server-side, so it's
    // deterministic and lands in the run's audited inputs.
    if (def.inputs.some((i) => i.key === "uxEnabled")) {
      const s = await readProjectSettings(root);
      inputs.uxEnabled = s.ux?.enabled === true;
      inputs.uxRules = s.ux?.rules ?? "";
      inputs.designDir = s.ux?.designDir || "docs/design";
    }
    const model = isSafeModelId(b.model) ? b.model : undefined;
    // per-role model choices — the model setting (role ids fixed)
    let roleModels: Partial<Record<StepRole, string>> | undefined;
    if (b.roleModels && typeof b.roleModels === "object") {
      roleModels = {};
      for (const k of STEP_ROLES) {
        const v = (b.roleModels as Record<string, unknown>)[k];
        if (isSafeModelId(v) && v) roleModels[k] = v;
      }
    }
    const run = startRun(root, def, inputs, b.agent, model, roleModels);
    if (!run) return NextResponse.json({ error: "could not start run" }, { status: 500 });
    return NextResponse.json({ runId: run.runId });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
