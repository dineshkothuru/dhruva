import { NextResponse } from "next/server";
import { changesSince, restoreFiles } from "@/lib/snapshot";
import path from "node:path";
import { isAttachableRoot } from "@/lib/fsguard";
import { isAgentId } from "@/lib/agents";
import { isSafeModelId } from "@/lib/agents";
import { builtinWorkflows } from "@/lib/workflows/builtins";
import { STEP_ROLES, type ChainLink, type StepRole } from "@/lib/workflows/schema";
import { readProjectSettings } from "@/lib/projectSettings";
import { ensureExtractedIn } from "@/lib/docExtract";
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
  resumeRun,
  startRun,
  hasActiveRun,
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
      (decision !== "approve" && decision !== "abort" && decision !== "revise" && decision !== "park")
    ) {
      return NextResponse.json(
        { error: "runId + decision (approve|abort|revise|park) required" },
        { status: 400 },
      );
    }
    // generous cap: "Revise with ALL findings" passes a full multi-finding
    // critique as the instruction - truncating it would silently drop findings
    const feedback =
      typeof b.feedback === "string" ? b.feedback.trim() : undefined;
    if (decision === "revise" && !feedback && !Array.isArray(b.cards)) {
      return NextResponse.json({ error: "revise requires feedback text" }, { status: 400 });
    }
    // Per-requirement rulings. Validated here rather than trusted: an id that
    // is not a REQ shape, or a verdict that is not one of the two, is dropped
    // rather than carried into the design document.
    const cards = Array.isArray(b.cards)
      ? (b.cards as unknown[])
          .filter(
            (c): c is { id: string; verdict: "approve" | "revise"; note?: string } =>
              !!c &&
              typeof c === "object" &&
              typeof (c as { id?: unknown }).id === "string" &&
              /^REQ-\d+$/.test((c as { id: string }).id) &&
              ((c as { verdict?: unknown }).verdict === "approve" ||
                (c as { verdict?: unknown }).verdict === "revise"),
          )
          .slice(0, 500)
          .map((c) => ({
            id: c.id,
            verdict: c.verdict,
            note: typeof c.note === "string" ? c.note.slice(0, 20_000) : undefined,
          }))
      : undefined;
    const ok = resolveGate(b.runId, { action: decision, feedback, cards });
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

  /** Put a failed or aborted run's file changes back.
   *
   * A run that dies after the implement step leaves half-finished edits in the
   * project, and undoing them by hand from a change list - with no record of
   * what the files looked like before - was the only way out, even though the
   * shadow store had been holding that exact state the whole time.
   *
   * Only for a run that has FINISHED badly. A running run is still writing, and
   * restoring under it would fight the agent; a successful run's changes are the
   * point of the run and are not undone here. */
  if (b.action === "restore") {
    if (typeof b.runId !== "string") {
      return NextResponse.json({ error: "runId required" }, { status: 400 });
    }
    if (hasActiveRun(root)) {
      return NextResponse.json(
        { error: "a run is in progress - stop it before restoring files" },
        { status: 409 },
      );
    }
    const run = (await listRuns(root)).find((r) => r.runId === b.runId);
    if (!run) return NextResponse.json({ error: "no such run" }, { status: 404 });
    if (run.status !== "failed" && run.status !== "aborted") {
      return NextResponse.json(
        { error: `this run is "${run.status}" - only a failed or aborted run can be restored` },
        { status: 400 },
      );
    }
    // Two honest reference points, because a rebaseline step deliberately moves
    // the diff base after an org refresh:
    //   "changes" -> baseCommit: exactly what the run reports having changed.
    //                The org files the retrieve pulled down are KEPT.
    //   "run"     -> startCommit: the project as it was before the run began,
    //                which also undoes that org refresh.
    // Default to "changes": it matches the list the user is looking at, and it
    // is the less destructive of the two.
    const wholeRun = b.scope === "run";
    const commit = wholeRun ? (run.startCommit ?? run.baseCommit) : run.baseCommit;
    if (!commit) {
      return NextResponse.json(
        { error: "this run has no baseline snapshot to restore from" },
        { status: 400 },
      );
    }
    // Undoing the whole run means every file that moved since it started, not
    // just the ones its own change list names - the retrieve's files are not in
    // that list precisely because the rebaseline excluded them.
    const files = wholeRun
      ? ((await changesSince(root, commit)) ?? []).map((c) => c.file)
      : (run.changes ?? []).map((c) => c.file);
    if (files.length === 0) {
      return NextResponse.json({ restored: [], removed: [], failed: [], note: "no changes to undo" });
    }
    return NextResponse.json({
      ...(await restoreFiles(root, commit, files)),
      scope: wholeRun ? "run" : "changes",
    });
  }

  if (b.action === "resume") {
    if (typeof b.runId !== "string") {
      return NextResponse.json({ error: "runId required" }, { status: 400 });
    }
    let resumeRoles: Partial<Record<StepRole, string>> | undefined;
    if (b.roleModels && typeof b.roleModels === "object") {
      resumeRoles = {};
      for (const k of STEP_ROLES) {
        const v = (b.roleModels as Record<string, unknown>)[k];
        if (isSafeModelId(v) && v) resumeRoles[k] = v;
      }
    }
    const run = await resumeRun(root, b.runId, resumeRoles);
    if (!run) {
      return NextResponse.json(
        { error: "cannot resume - run is live/finished/unknown, or the workflow definition changed since (start a fresh run)" },
        { status: 400 },
      );
    }
    return NextResponse.json({ runId: run.runId });
  }

  if (b.action === "pending") {
    return NextResponse.json({
      pendingGates: pendingGateCount(root),
      activeRun: hasActiveRun(root),
    });
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
      if (typeof v === "string") inputs[k] = v;
    }
    // Project-settings injection: when the workflow declares the UX inputs,
    // fill them from .dhruva/settings.json - server-side, so it's
    // deterministic and lands in the run's audited inputs.
    if (def.inputs.some((i) => i.key === "uxEnabled")) {
      const s = await readProjectSettings(root);
      inputs.uxEnabled = s.ux?.enabled === true;
      inputs.uxRules = s.ux?.rules ?? "";
      inputs.designDir = s.ux?.designDir || ".dhruva/uxdesignfiles";
    }
    // binary documents (.docx/.pdf) in the attachments and design folders get
    // their agent-readable .extracted.md siblings BEFORE any agent runs -
    // covers files dropped into folders that never passed through upload
    const scanDirs = [".dhruva/attachments"];
    if (typeof inputs.designDir === "string" && inputs.designDir) scanDirs.push(inputs.designDir);
    await ensureExtractedIn(root, scanDirs);
    const model = isSafeModelId(b.model) ? b.model : undefined;
    // per-role model choices - the model setting (role ids fixed)
    let roleModels: Partial<Record<StepRole, string>> | undefined;
    if (b.roleModels && typeof b.roleModels === "object") {
      roleModels = {};
      for (const k of STEP_ROLES) {
        const v = (b.roleModels as Record<string, unknown>)[k];
        if (isSafeModelId(v) && v) roleModels[k] = v;
      }
    }
    // multi-workflow chain ("design and implement"): the run started here is
    // link 0; the engine auto-starts each following link on a clean finish.
    // Every link must resolve to a real workflow NOW - failing at the handoff
    // hours later would waste the finished phases.
    let chain: ChainLink[] | undefined;
    if (Array.isArray(b.chain) && b.chain.length >= 2 && b.chain.length <= 5) {
      chain = [];
      for (const raw of b.chain as unknown[]) {
        const l = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
        if (!l || typeof l.workflowId !== "string" || l.workflowId.length > 80) {
          return NextResponse.json({ error: "invalid chain link" }, { status: 400 });
        }
        const li: Record<string, string | boolean> = {};
        if (l.inputs && typeof l.inputs === "object") {
          for (const [k, v] of Object.entries(l.inputs)) {
            if (typeof v === "boolean") li[k] = v;
            else if (typeof v === "string") li[k] = v;
          }
        }
        chain.push({
          workflowId: l.workflowId,
          title: typeof l.title === "string" ? l.title.slice(0, 80) : l.workflowId,
          inputs: li,
        });
      }
      if (chain[0].workflowId !== def.id) {
        return NextResponse.json({ error: "chain link 0 must be the started workflow" }, { status: 400 });
      }
      for (const l of chain.slice(1)) {
        if (!(await loadWorkflow(root, l.workflowId))) {
          return NextResponse.json(
            { error: `chain link "${l.workflowId}" is not a known workflow` },
            { status: 400 },
          );
        }
      }
    }
    const run = startRun(
      root,
      def,
      inputs,
      b.agent,
      model,
      roleModels,
      chain,
      chain ? 0 : undefined,
      b.autoGate === true,
    );
    if (!run) {
      // startRun refuses a second run on a project: one working tree and one
      // snapshot store, neither divisible between two runs.
      if (hasActiveRun(root)) {
        return NextResponse.json(
          {
            error:
              "a run is already active on this project - wait for it to finish, or stop it first. " +
              "Two runs would edit the same files and each would report the other's changes.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "could not start run" }, { status: 500 });
    }
    return NextResponse.json({ runId: run.runId });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
