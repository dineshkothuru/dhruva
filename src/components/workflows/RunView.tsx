"use client";

import type { AgentId } from "@/lib/agents";
import type { RunState } from "@/lib/workflows/schema";
import { Icon } from "@/components/icons";
import StepBody, {
  FindingCard,
  STATUS_EDGE,
  STATUS_ICON,
  TYPE_CHIP,
} from "@/components/workflows/StepTrace";
import { ConfirmButton, stepRows } from "@/components/workflows/workflowsShared";
import RequirementCards, { parseRequirements } from "@/components/workflows/RequirementCards";
import { rolesFor } from "@/lib/roleStore";
import { parseFindings } from "@/lib/findings";

/** The run view - one run's live trace, gates, chain rail, and controls.
 * Extracted from the WorkflowsPane monolith as a PURE MOVE: all state and
 * handlers stay in the pane and arrive as props, so behavior is unchanged and
 * the 800-line view can be read (and reviewed) on its own. */

export interface RunViewProps {
  root: string;
  run: RunState;
  agent: AgentId;
  api: (body: Record<string, unknown>) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
  gate: (
    decision: "approve" | "abort" | "revise" | "park",
    feedback?: string,
    cards?: { id: string; verdict: "approve" | "revise"; note?: string }[],
  ) => Promise<void>;
  gating: boolean;
  gateNote: string;
  setGateNote: (v: string) => void;
  cards: { id: string; verdict: "approve" | "revise"; note?: string }[];
  setCards: (v: { id: string; verdict: "approve" | "revise"; note?: string }[]) => void;
  docs: Record<string, string>;
  explain: Record<string, string>;
  explaining: string | null;
  explainFailure: (rawStepId: string, stepTitle: string, output: string) => Promise<void>;
  fetchRunState: (runId: string) => Promise<void>;
  openRunById: (runId: string) => Promise<void>;
  setRun: (r: RunState | null) => void;
  setHistory: (h: RunState[]) => void;
  error: string | null;
  setError: (v: string | null) => void;
  notice: string | null;
  setNotice: (v: string | null) => void;
  onOpenDiff?: (rel: string, pin?: { base?: string; end?: string }) => void;
}

export default function RunView({
  root,
  run,
  agent,
  api,
  gate,
  gating,
  gateNote,
  setGateNote,
  cards,
  setCards,
  docs,
  explain,
  explaining,
  explainFailure,
  fetchRunState,
  openRunById,
  setRun,
  setHistory,
  error,
  setError,
  notice,
  setNotice,
  onOpenDiff,
}: RunViewProps) {
    const totalIn = run.steps.reduce((n, s) => n + (s.usage?.inTokens ?? 0), 0);
    const totalOut = run.steps.reduce((n, s) => n + (s.usage?.outTokens ?? 0), 0);
    const totalCost = run.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
    return (
      <div className="flex-1 overflow-y-auto p-6">
        {/* errors/notices raised FROM the run view (failed gate posts, stop/
            resume/restore results) rendered nowhere before this - the banners
            lived only in the catalog branch, so every message set here was
            invisible and the buttons looked simply broken */}
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
            <button
              onClick={() => setError(null)}
              className="shrink-0 rounded px-1 text-red-400 hover:text-red-700"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        {notice && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{notice}</span>
            <button
              onClick={() => setNotice(null)}
              className="shrink-0 rounded px-1 text-slate-400 hover:text-slate-700"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={async () => {
              setRun(null);
              const r = await api({ action: "runs", root });
              if (r.ok) setHistory((r.data.runs as RunState[]) ?? []);
            }}
            className="text-xs text-slate-500 hover:underline"
          >
            ← workflows
          </button>
          <h2 className="text-sm font-semibold">{run.workflowTitle}</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
              run.status === "done"
                ? "bg-emerald-100 text-emerald-700"
                : run.status === "failed" || run.status === "aborted"
                  ? "bg-red-100 text-red-700"
                  : "bg-sky-100 text-sky-700"
            }`}
          >
            <span className={`mr-1 inline-flex h-1.5 w-1.5 rounded-full ${run.status === "running" ? "animate-pulse bg-sky-500" : run.status === "waiting_gate" ? "animate-pulse bg-amber-500" : run.status === "done" ? "bg-emerald-500" : "bg-red-400"}`} />{run.status.replace("_", " ")}
          </span>
          {/* A run that found the requirement already satisfied ends "done"
              having deliberately built nothing. Without saying so, an emerald
              DONE badge reads as a successful build and deploy. */}
          {run.noWork && (
            <span
              className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600"
              title="The design found the requirement already satisfied, so nothing was implemented, validated or deployed."
            >
              no changes needed
            </span>
          )}
          {run.autoGate && (
            <span
              className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-700"
              title="Every gate in this run is approved automatically without stopping - you chose this when starting the chain. Nothing pauses for review."
            >
              {<Icon.robot size={12} strokeWidth={1.75} className="inline shrink-0 text-violet-500" />} gates auto-approved
            </span>
          )}
          <span className="ml-auto font-mono text-[11px] text-slate-400">run {run.runId}</span>
          {(run.status === "running" || run.status === "waiting_gate") && (
            <ConfirmButton
              label="■ Stop run"
              armed="■ Click again to stop"
              title="Abort the run - kills the running step's process and skips the remaining steps"
              className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-600 hover:bg-red-100"
              onConfirm={async () => {
                const { data } = await api({ action: "stop", runId: run.runId });
                if (data && data.stopped === false) {
                  setError(
                    "This run could not be stopped - the server no longer has it in memory " +
                      "(it was most likely restarted). Reload the page to see its real state.",
                  );
                }
                await fetchRunState(run.runId);
              }}
            />
          )}
          {(run.status === "failed" || run.status === "aborted") && (
            <button
              onClick={async () => {
                const { ok, data } = await api({
                  action: "resume",
                  root,
                  runId: run.runId,
                  roleModels: rolesFor(run.agent),
                });
                if (!ok) setError(String(data.error ?? "cannot resume"));
                else await fetchRunState(run.runId);
              }}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
              title="Re-run from the first incomplete step - completed steps and approved gates are kept"
            >
              ⟳ Resume run
            </button>
          )}
          {/* A run that died after the implement step leaves half-finished
              edits behind. The shadow store already holds the pre-run state, so
              undoing them is one command - it just had no button.

              Two scopes, because a rebaseline step moves the diff base after an
              org refresh: "changes" is what the run reports having changed and
              keeps the retrieved org files; "run" goes back to before the run
              began and drops them too. The second only appears when a
              rebaseline actually moved the base, so it is offered exactly when
              it would do something different. */}
          {(run.status === "failed" || run.status === "aborted") &&
            (run.changes?.length ?? 0) > 0 && (
              <ConfirmButton
                label="↺ Undo file changes"
                armed={`↺ Click again to undo ${run.changes?.length ?? 0} file(s)`}
                title="Restore the files this run reports changing, from the snapshot it measured them against. Files retrieved from the org are kept. This cannot be undone."
                className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
                onConfirm={async () => {
                  const { ok, data } = await api({ action: "restore", root, runId: run.runId });
                  if (!ok) {
                    setError(String(data.error ?? "could not restore the files"));
                    return;
                  }
                  const restored = (data.restored as string[] | undefined)?.length ?? 0;
                  const removed = (data.removed as string[] | undefined)?.length ?? 0;
                  const failed = (data.failed as { file: string }[] | undefined) ?? [];
                  const NL = String.fromCharCode(10);
                  const summary = [
                    restored + " file(s) restored, " + removed + " created file(s) deleted.",
                  ];
                  if (failed.length) {
                    summary.push("", failed.length + " could not be put back:");
                    for (const f of failed) summary.push("  " + f.file);
                  }
                  setNotice(summary.join(NL));
                  await fetchRunState(run.runId);
                }}
              />
            )}
          {(run.status === "failed" || run.status === "aborted") &&
            !!run.startCommit &&
            !!run.baseCommit &&
            run.startCommit !== run.baseCommit && (
              <ConfirmButton
                label="↺ …and the org refresh"
                armed="↺ Click again to undo the whole run"
                title="Go further back: the project as it was BEFORE this run began, including undoing the org refresh, so files it retrieved from the org are removed too. This cannot be undone."
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                onConfirm={async () => {
                  const { ok, data } = await api({
                    action: "restore",
                    root,
                    runId: run.runId,
                    scope: "run",
                  });
                  if (!ok) {
                    setError(String(data.error ?? "could not restore the files"));
                    return;
                  }
                  const restored = (data.restored as string[] | undefined)?.length ?? 0;
                  const removed = (data.removed as string[] | undefined)?.length ?? 0;
                  const NL = String.fromCharCode(10);
                  setNotice(
                    [
                      "Back to the state before the run started.",
                      restored + " file(s) restored, " + removed + " file(s) removed.",
                    ].join(NL),
                  );
                  await fetchRunState(run.runId);
                }}
              />
            )}
        </div>
        <p className="mb-3 text-[11px] text-slate-500">
          <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium">
            {run.agent}
            {run.model ? ` · ${run.model}` : " · default model"}
          </span>
          {totalIn + totalOut > 0 && (
            <>
              {totalIn.toLocaleString()} in / {totalOut.toLocaleString()} out tokens ·{" "}
              {totalCost < 0.01 ? `$${totalCost.toFixed(4)}` : `$${totalCost.toFixed(2)}`} at API
              rates (runs on your subscription - not billed)
            </>
          )}
        </p>

        {run.chain && run.chain.length > 1 && (
          <div className="mb-3 rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50/70 via-white to-white px-3.5 py-2.5">
            <div className="flex items-center gap-2 overflow-x-auto">
              <span className="shrink-0 text-[11px] font-bold uppercase tracking-widest text-indigo-400">
                {<Icon.chain size={12} strokeWidth={1.75} className="inline shrink-0 text-indigo-400" />} Chain
              </span>
              {run.chain.map((c, ci) => {
                const idx = run.chainIndex ?? 0;
                const live = run.status === "running" || run.status === "waiting_gate";
                const state =
                  ci < idx ? "done" : ci === idx ? "current" : c.runId ? "started" : "queued";
                const clickable = !!c.runId && c.runId !== run.runId;
                return (
                  <span key={ci} className="flex shrink-0 items-center gap-2">
                    {ci > 0 && (
                      <span
                        className={`text-sm ${
                          ci === idx + 1 && live ? "animate-pulse text-indigo-400" : "text-slate-300"
                        }`}
                        title="starts automatically after a clean finish"
                      >
                        →
                      </span>
                    )}
                    <button
                      onClick={() => clickable && void openRunById(c.runId!)}
                      disabled={!clickable}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                        state === "done"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400"
                          : state === "current"
                            ? "border-indigo-500 bg-indigo-600 text-white shadow-sm"
                            : state === "started"
                              ? "animate-pulse border-sky-300 bg-sky-50 text-sky-700 hover:border-sky-500"
                              : "border-dashed border-slate-300 bg-white text-slate-400"
                      } ${clickable ? "" : "cursor-default"}`}
                      title={
                        state === "done"
                          ? "finished - open this phase's run"
                          : state === "started"
                            ? "running now - open the live run"
                            : state === "current"
                              ? "this run"
                              : "queued - starts after the previous phase finishes clean"
                      }
                    >
                      {(() => {
                        const I =
                          state === "done"
                            ? Icon.check
                            : state === "current"
                              ? live
                                ? Icon.running
                                : run.status === "done"
                                  ? Icon.check
                                  : Icon.stop
                              : state === "started"
                                ? Icon.run
                                : Icon.pending;
                        return (
                          <I
                            size={11}
                            strokeWidth={2.25}
                            className={state === "current" && live ? "animate-pulse" : ""}
                          />
                        );
                      })()}
                      {c.title}
                      {state === "started" && (
                        <span className="text-[11px] font-semibold uppercase">live</span>
                      )}
                    </button>
                  </span>
                );
              })}
              <span className="ml-auto hidden shrink-0 pl-3 text-[11px] text-slate-400 lg:inline">
                phase {(run.chainIndex ?? 0) + 1} of {run.chain.length} · the next phase
                auto-starts on a clean finish; fail or abort pauses the chain
              </span>
            </div>

            {/* the chain has moved on - do not strand the reader on a phase
                that is already finished */}
            {(() => {
              const idx = run.chainIndex ?? 0;
              const next = run.chain[idx + 1];
              if (run.status !== "done" || !next) return null;
              return next.runId ? (
                <button
                  onClick={() => void openRunById(next.runId!)}
                  className="mt-2 flex w-full items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-left text-[11px] text-sky-800 transition-colors hover:border-sky-300 hover:bg-sky-100"
                >
                  <Icon.run size={13} strokeWidth={2} className="shrink-0 animate-pulse" />
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{next.title}</span> started automatically and is
                    running now.
                  </span>
                  <span className="shrink-0 font-medium">Open it</span>
                  <Icon.chevron size={12} strokeWidth={2} className="shrink-0" />
                </button>
              ) : (
                <p className="mt-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                  <Icon.running size={12} strokeWidth={2} className="shrink-0 animate-pulse" />
                  Starting <span className="font-semibold">{next.title}</span>…
                </p>
              );
            })()}
          </div>
        )}

        {(run.manualSteps?.length ?? 0) > 0 && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-amber-700">
              {<Icon.humanGate size={12} strokeWidth={1.75} className="inline shrink-0 text-amber-600" />} Manual steps for a human · {run.manualSteps!.length}
              {run.chain && run.chain.length > 1 && (
                <span className="font-medium normal-case tracking-normal text-amber-600">
                  (collected across the chain&apos;s phases)
                </span>
              )}
            </p>
            <p className="mt-1 text-[11px] text-amber-700/80">
              The agents flagged these as actions they cannot perform from this machine - do them
              in the org yourself.
            </p>
            <ol className="mt-2 space-y-1.5">
              {run.manualSteps!.map((m, mi) => (
                <li key={mi} className="flex items-start gap-2 text-xs text-amber-900">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-800">
                    {mi + 1}
                  </span>
                  <span className="min-w-0">
                    {m.text}
                    <span className="ml-1.5 rounded-md bg-white/70 px-1.5 py-px text-[11px] font-medium text-amber-600">
                      {m.phase && m.phase !== run.workflowTitle ? `${m.phase} · ` : ""}
                      {m.stepId}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {Object.keys(run.inputs ?? {}).length > 0 && (
          <details className="mb-3 rounded-xl border border-slate-200 bg-white">
            <summary className="cursor-pointer px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-slate-400 hover:text-slate-700">
              {<Icon.inputs size={12} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} Run inputs - what this run was asked to do
            </summary>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 border-t border-slate-100 px-4 py-3 sm:grid-cols-2 xl:grid-cols-3">
              {Object.entries(run.inputs).map(([k, v]) => {
                const val = typeof v === "boolean" ? (v ? "yes" : "no") : String(v).slice(0, 2000);
                const long = val.length > 90 || val.includes("\n");
                return (
                  <div key={k} className={long ? "sm:col-span-2 xl:col-span-3" : ""}>
                    <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{k}</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">
                      {val || <span className="text-slate-300">empty</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </details>
        )}
        {/* the journey at a glance: where the run is, what's left, where the
            human comes in (gates marked). Pure render - zero tokens. */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-y-2">
            {run.steps.map((s, i) => (
              <span key={s.id} className="flex items-center">
                {i > 0 && <span className="mx-1 h-px w-3 bg-slate-200" />}
                <span
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    s.status === "done"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : s.status === "running"
                        ? "border-sky-300 bg-sky-50 text-sky-700 ring-2 ring-sky-100"
                        : s.status === "waiting_gate"
                          ? "border-amber-300 bg-amber-50 text-amber-700 ring-2 ring-amber-100"
                          : s.status === "failed"
                            ? "border-red-200 bg-red-50 text-red-600"
                            : s.status === "skipped"
                              ? "border-slate-100 bg-slate-50 text-slate-300 line-through"
                              : "border-slate-200 bg-white text-slate-400"
                  }`}
                  title={`${s.title} (${s.type}) - ${s.status}`}
                >
                  {(() => {
                    const I =
                      s.type === "gate"
                        ? Icon.humanGate
                        : s.status === "done"
                          ? Icon.check
                          : s.status === "failed"
                            ? Icon.failed
                            : s.status === "running"
                              ? Icon.running
                              : Icon.pending;
                    return <I size={11} strokeWidth={2} className={s.status === "running" ? "animate-pulse" : ""} />;
                  })()}
                  <span className="max-w-24 truncate">{s.id}</span>
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            {(() => {
              const cur = run.steps.find((s) => s.status === "running" || s.status === "waiting_gate");
              const doneN = run.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
              if (run.status === "done") return "Run complete - every step finished.";
              if (run.status === "failed" || run.status === "aborted")
                return "Run stopped - use Resume to continue from the first incomplete step.";
              if (cur?.status === "waiting_gate")
        return ` YOUR decision: "${cur.title}" - the run is paused until you act (${doneN}/${run.steps.length} steps done).`;
       if (cur) return `Working: "${cur.title}" (${doneN}/${run.steps.length} steps done). marks where you decide.`;
              return `${doneN}/${run.steps.length} steps done.`;
            })()}
          </p>
        </div>

        <div className="space-y-2">
          {stepRows(run).map((s) => (
            <details
              key={s.rowKey}
              open={s.status === "running" || s.status === "waiting_gate" || s.status === "failed"}
              className={`rounded-xl border border-l-4 transition-shadow ${
                STATUS_EDGE[s.status] ?? "border-l-slate-200"
              } ${
                s.status === "waiting_gate"
                  ? "border-amber-300 bg-white ring-1 ring-amber-200 shadow-lg shadow-amber-100/70"
                  : s.status === "pending"
                    ? "border-slate-200 bg-slate-50/60"
                    : "border-slate-200 bg-white shadow-sm"
              }`}
            >
              <summary
                className={`flex items-center gap-2 px-4 py-2.5 text-sm ${
                  s.status === "pending" ? "cursor-default list-none" : "cursor-pointer"
                }`}
              >
                {(() => {
                  const I = STATUS_ICON[s.status] ?? Icon.pending;
                  const tone =
                    s.status === "done"
                      ? "text-emerald-600"
                      : s.status === "failed"
                        ? "text-red-500"
                        : s.status === "waiting_gate"
                          ? "text-amber-500"
                          : s.status === "running"
                            ? "text-sky-500 animate-pulse"
                            : "text-slate-300";
                  return <I size={15} strokeWidth={2} className={`shrink-0 ${tone}`} />;
                })()}
                <span className="min-w-0 flex-1">
                  <span
                    className={
                      s.status === "skipped"
                        ? "text-slate-400 line-through"
                        : s.status === "pending"
                          ? "text-slate-400"
                          : "font-medium text-slate-800"
                    }
                  >
                    {s.title}
                  </span>
                  {/* a step that ran more than once says which run this row is,
                      and why it was replaced - otherwise four identical titles
                      in a row are unreadable */}
                  {s.attemptsTotal > 1 && (
                    <span
                      className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-600"
                      title={
                        s.supersededBy
                          ? `Superseded by ${s.supersededBy}`
                          : "The latest run of this step"
                      }
                    >
                      run {s.attemptNo} of {s.attemptsTotal}
                      {s.supersededBy ? ` · ${s.supersededBy}` : ""}
                    </span>
                  )}
                  {/* a step that has not run yet says so, instead of being an
                      unexplained empty row */}
                  {s.status === "pending" && (
                    <span className="ml-2 text-[11px] text-slate-300">not started</span>
                  )}
                  {s.status === "skipped" && (
                    <span className="ml-2 text-[11px] text-slate-400">skipped</span>
                  )}
                  {s.startedAt && s.endedAt && s.status !== "pending" && (
                    <span className="ml-2 text-[11px] text-slate-400">
                      {(() => {
                        const sec = Math.round((s.endedAt - s.startedAt) / 1000);
                        return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
                      })()}
                    </span>
                  )}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {s.type === "agent" && s.model && s.model !== "default" && (
                    <span
                      className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-500"
                      title={s.modelFrom ? `model source: ${s.modelFrom}` : undefined}
                    >
                      {s.model}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                      TYPE_CHIP[s.type] ?? "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {s.type}
                  </span>
                </span>
              </summary>
              {s.status === "waiting_gate" ? (
                <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="whitespace-pre-wrap text-sm text-amber-800">{s.output}</p>
                  {(() => {
                    // the reviewer's UNRESOLVED objections belong AT the gate -
                    // the human decides against them, so show them here. Search
                    // only the steps SINCE THE PREVIOUS GATE: earlier phases'
                    // blocked reviews were already ruled on at their own gate.
                    const gateIdx = run.steps.findIndex((x) => x.id === s.id);
                    let prevGateIdx = -1;
                    for (let k = gateIdx - 1; k >= 0; k--) {
                      if (run.steps[k].type === "gate") {
                        prevGateIdx = k;
                        break;
                      }
                    }
                    const segment = run.steps.slice(prevGateIdx + 1, gateIdx);
                    const reviewer = [...segment]
                      .reverse()
                      .find((x) => x.type === "agent" && /VERDICT:\s*BLOCKED/i.test(x.output));
                    if (!reviewer) return null;
                    const fm = reviewer.output.match(/\*{0,2}F\d+[\s:(]/);
                    const findings = fm
                      ? reviewer.output.slice(fm.index)
                      : reviewer.output;
                    const gateParsed = parseFindings(findings);
                    return (
                      <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-red-600">
                          Reviewer findings - still BLOCKED after the auto-fix round
                        </p>
                        {gateParsed.findings.length > 0 ? (
                          <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
                            {gateParsed.findings.map((f, fi) => (
                              <FindingCard key={`${f.id}-${fi}`} f={f} />
                            ))}
                          </div>
                        ) : (
                          <pre className="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-white/60 p-2 text-xs text-slate-700">
                            {findings}
                          </pre>
                        )}
                        <button
                          onClick={() =>
                            gate(
                              "revise",
                              `Address EVERY blocking finding from the design reviewer, exactly as each Fix line specifies. Do not re-argue a finding - implement its fix or state explicitly why it is impossible:\n\n${findings}`,
                            )
                          }
                          disabled={gating}
                          className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                        >
                          ⟳ Revise with ALL findings
                        </button>
                      </div>
                    );
                  })()}
                  {(() => {
                    // itemized review: if a step SINCE THE PREVIOUS GATE
                    // produced REQ blocks, render per-requirement cards -
                    // never resurrect an earlier phase's cards at later gates
                    // (approving them there would masquerade as a design review)
                    const gateIdx = run.steps.findIndex((x) => x.id === s.id);
                    let prevGateIdx = -1;
                    for (let k = gateIdx - 1; k >= 0; k--) {
                      if (run.steps[k].type === "gate") {
                        prevGateIdx = k;
                        break;
                      }
                    }
                    const segment = run.steps.slice(prevGateIdx + 1, gateIdx);
                    // The DOCUMENT the step wrote, when it wrote one - a delta
                    // carries only the changed blocks, so cards built from the
                    // step's output would silently drop the rest of the design.
                    const source = [...segment]
                      .reverse()
                      .find(
                        (x) =>
                          x.type === "agent" &&
                          ((x.artifact && docs[x.artifact]?.includes("### REQ-")) ||
                            x.output.includes("### REQ-")),
                      );
                    if (!source) return null;
                    const body = (source.artifact && docs[source.artifact]) || source.output;
                    const items = parseRequirements(body);
                    if (items.length === 0) return null;
                    // map reviewer findings to the REQ ids they mention, so
                    // each card shows WHY the critic objected to it
                    const reviewer = [...segment]
                      .reverse()
                      .find((x) => x.type === "agent" && /VERDICT:\s*BLOCKED/i.test(x.output));
                    const critique: Record<string, string[]> = {};
                    if (reviewer) {
                      const parts = reviewer.output.split(/(?=\*{0,2}F\d+[\s:(])/);
                      for (const p of parts) {
                        // new format: "F1 (critical) [refs: REQ-007]: title"
                        const neu = p.match(
                          /^\*{0,2}(F\d+)\s*\((critical|important|nit)\)\s*\[refs:\s*([^\]]*)\]\s*:\s*(.{0,300}?)(?:\n|\*\*|$)/s,
                        );
                        // legacy format: "F1: title (critical)"
                        const old = neu
                          ? null
                          : p.match(/^\*{0,2}(F\d+):\s*(.{0,300}?)\s*\((critical|important|nit)\)/s);
                        if (!neu && !old) continue;
                        const id = neu ? neu[1] : old![1];
                        const sev = neu ? neu[2] : old![3];
                        const title = (neu ? neu[4] : old![2]).replace(/\*+/g, "").trim();
                        const problem =
                          p.match(/Problem:\s*([\s\S]{0,300}?)(?:\n\s*Fix:|$)/)?.[1]?.trim() ?? "";
                        const text = `${id} (${sev}): ${title} - ${problem}`;
                        // refs come from the declared [refs:] list when present,
                        // else fall back to scanning the finding body
                        const refs = neu
                          ? (neu[3].match(/(?:REQ|UX|T)-\d+/g) ?? [])
                          : (p.match(/REQ-\d+/g) ?? []);
                        for (const reqId of new Set(refs)) {
                          (critique[reqId] ??= []).push(text);
                        }
                      }
                    }
                    return (
                      <RequirementCards
                        items={items}
                        critique={critique}
                        disabled={gating}
                        onChange={setCards}
                        onApproveAll={() => gate("approve")}
                        // The verdicts decide the action: anything sent back
                        // makes it a revision, otherwise it is an approval of
                        // exactly the cards named. The engine reads the cards.
                        onSubmit={(cards) =>
                          gate(
                            cards.some((c) => c.verdict === "revise") ? "revise" : "approve",
                            undefined,
                            cards,
                          )
                        }
                      />
                    );
                  })()}
                  <textarea
                    value={gateNote}
                    onChange={(e) => setGateNote(e.target.value)}
                    rows={2}
                    placeholder="Optional instructions - e.g. 'use a flow instead of a trigger', 'split the service class'. Filling this enables Revise: the previous analysis re-runs following your instructions, then gates again."
                    className="mt-3 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs outline-none focus:border-amber-400"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => gate("approve", undefined, cards)}
                      disabled={gating}
                      className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                    >
                      {gating ? "…" : "Approve & continue"}
                    </button>
                    {/* Partial delivery: five unanswered questions should not
                        hold an otherwise finished epic. The blocked
                        requirements keep their design and move to
                        pending-design.md; the documents are written from the
                        rest. */}
                    <button
                      onClick={() => gate("park")}
                      disabled={gating}
                      className="rounded-lg border border-violet-300 bg-violet-50 px-4 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-40"
                      title="Set aside the requirements that are blocked only on a human decision, and write the documents from the rest. Nothing is lost - the parked work is kept in pending-design.md with the questions that stopped it."
                    >
                      Park blocked &amp; proceed
                    </button>
                    <button
                      onClick={() => gate("revise", gateNote, cards)}
                      disabled={gating || (!gateNote.trim() && cards.length === 0)}
                      className="rounded-lg border border-amber-400 bg-white px-4 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-40"
                      title="Re-run the analysis with your instructions, then review again"
                    >
                      Revise with instructions
                    </button>
                    <button
                      onClick={() => gate("abort")}
                      disabled={gating}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
                    >
                      Abort run
                    </button>
                  </div>
                </div>
              ) : (
                <StepBody
                  output={s.output}
                  type={s.type}
                  baseCommit={s.baseCommit}
                  onOpenDiff={onOpenDiff}
                  // never show "working…" unless the RUN itself is still live
                  running={
                    s.status === "running" &&
                    (run.status === "running" || run.status === "waiting_gate")
                  }
                />
              )}
              {s.status === "failed" && s.output && (
                <div className="border-t border-slate-100 px-4 py-2">
                  {explain[`${run.runId}:${s.id}`] === undefined ? (
                    <button
                      onClick={() => explainFailure(s.id, s.title, s.output)}
                      disabled={explaining !== null}
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                    >
           {explaining === `${run.runId}:${s.id}` ? "Diagnosing…" : " Explain & suggest fix"}
                    </button>
                  ) : (
                    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sky-600">
                        Diagnosis ({run?.agent ?? agent})
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-xs text-slate-700">
                        {explain[`${run.runId}:${s.id}`] || "analysing…"}
                      </pre>
                    </div>
                  )}
                </div>
              )}
              {s.usage && (
                <p className="border-t border-slate-100 px-4 py-1.5 text-[11px] text-slate-400">
                  {s.model && (
                    <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5" title={s.modelFrom ? `model source: ${s.modelFrom}` : undefined}>
                      {s.model}
                      {s.modelFrom && <span className="ml-1 text-slate-400">· {s.modelFrom}</span>}
                    </span>
                  )}
                  {s.usage.estimated ? "~" : ""}
                  {s.usage.inTokens.toLocaleString()} in / {s.usage.outTokens.toLocaleString()} out
                  tokens · $
                  {s.usage.costUsd < 0.01 ? s.usage.costUsd.toFixed(4) : s.usage.costUsd.toFixed(2)}{" "}
                  {s.usage.estimated ? "(est. at API rates)" : "(reported by the agent)"}
                </p>
              )}
              {s.id === "changes" && run.changes && run.changes.length > 0 && (
                <div className="border-t border-slate-100 px-4 py-2">
                  {!run.baseCommit && (
                    <p className="mb-1.5 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
                      <Icon.warn size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                      This run has no pinned commits, so its diffs cannot be replayed. Opening a
                      file compares it against the latest snapshot instead.
                    </p>
                  )}
                  {run.changes.map((c) => (
                    <button
                      key={c.file}
                      onClick={() =>
                        onOpenDiff?.(
                          c.file,
                          run.baseCommit
                            ? { base: run.baseCommit, end: run.endCommit }
                            : undefined,
                        )
                      }
                      className="block w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-slate-100"
                      title="Open diff"
                    >
                      <span className="mr-2 text-[11px] font-semibold uppercase text-amber-600">
                        {c.status}
                      </span>
                      {c.file}
                    </button>
                  ))}
                </div>
              )}
            </details>
          ))}
        </div>

      </div>
    );
}
