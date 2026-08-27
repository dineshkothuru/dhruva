"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents";
import type { RunState } from "@/lib/workflows/schema";
import CliResult from "@/components/workflows/CliResult";
import { loadRoles, saveRoles, rolesFor, type RoleConfig } from "@/lib/roleStore";
import { STEP_ROLES, ROLE_LABEL, ROLE_TIER } from "@/lib/workflows/schema";
import { loadDefaultAgent, saveDefaultAgent } from "@/lib/agentStore";
import { loadCustomModels, addCustomModel } from "@/lib/modelStore";
import WorkflowBuilder, { type BuilderSeed } from "@/components/workflows/WorkflowBuilder";
import RequirementCards, { parseRequirements } from "@/components/workflows/RequirementCards";

interface CatalogItem {
  id: string;
  title: string;
  description: string;
  custom?: boolean;
  /** custom workflows: where they live - central (all projects) or project. */
  scope?: "central" | "project";
  /** full step list - powers duplicate-to-customize. */
  steps?: Record<string, unknown>[];
  inputs: {
    key: string;
    label: string;
    kind: "text" | "boolean" | "select";
    options?: string[];
    default?: string | boolean;
    attachTo?: boolean;
    hidden?: boolean;
  }[];
}

/** Catalog grouping - anything unlisted lands in the first group. */
const CATEGORIES: [string, string[]][] = [
  ["Development", ["bug-fix", "feature-dev", "solution-design", "ux-design", "implement-tdd"]],
  ["Testing", ["test-gen", "run-tests"]],
  ["Org & deployment", ["retrieve-sync", "deploy-preview", "validate-deploy", "scratch-org"]],
  ["Custom", []],
];

const AGENT_OPTIONS: { id: AgentId; label: string }[] = [
  { id: "copilot", label: "GitHub Copilot" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "OpenAI Codex" },
  { id: "cursor", label: "Cursor" },
];

const STATUS_ICON: Record<string, string> = {
  pending: "◻",
  running: "⏳",
  waiting_gate: "✋",
  done: "✅",
  failed: "❌",
  skipped: "⤼",
};

/** Colored left edge per step status - the run's frontier at a glance. */
const STATUS_EDGE: Record<string, string> = {
  pending: "border-l-slate-200",
  running: "border-l-sky-400",
  waiting_gate: "border-l-amber-400",
  done: "border-l-emerald-400",
  failed: "border-l-red-400",
  skipped: "border-l-slate-200",
};

/** Type chip tint: AI steps stand apart from deterministic ones. */
const TYPE_CHIP: Record<string, string> = {
  agent: "bg-violet-50 text-violet-600",
  gate: "bg-amber-50 text-amber-600",
  verify: "bg-teal-50 text-teal-600",
  cli: "bg-slate-100 text-slate-500",
  snapshot: "bg-slate-100 text-slate-500",
  changes: "bg-slate-100 text-slate-500",
  "tasks-check": "bg-teal-50 text-teal-600",
};

function runCost(r: RunState): number {
  return r.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
}
function fmtCost(c: number): string {
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

/** Structured step-output view: agent narration as prose, tool calls as
 * rows, exit/engine/error lines as badges; auto-follows while streaming. */
function StepBody({
  output,
  type,
  running,
}: {
  output: string;
  type: string;
  running: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (running) boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [output, running]);

  if (!output) {
    return running ? (
      <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-400">
        <span className="mr-1 inline-block animate-pulse text-sky-500">●</span>
        running - output streams here…
      </p>
    ) : null;
  }

  // cli steps: render recognized sf --json shapes as tables once finished
  // (CliResult falls back to the terminal view for unrecognized output)
  if (type === "cli" && !running) {
    return <CliResult output={output} />;
  }

  // verify / changes / streaming cli output stays terminal-style
  if (type !== "agent") {
    return (
      <div ref={boxRef} className="max-h-72 overflow-y-auto border-t border-slate-100">
        <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-slate-600">
          {output}
        </pre>
      </div>
    );
  }

  const lines = output.split("\n");
  return (
    <div ref={boxRef} className="max-h-80 space-y-0.5 overflow-y-auto border-t border-slate-100 px-4 py-3">
      {lines.map((line, i) => {
        const t = line.trimEnd();
        if (!t) return null;
        if (t.startsWith("⚙")) {
          return (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-500"
            >
              <span className="text-sky-500">⚙</span>
              <span className="truncate">{t.slice(1).trim()}</span>
            </div>
          );
        }
        const exit = t.match(/^\[exit (-?\d+)\]$/);
        if (exit) {
          const ok = exit[1] === "0";
          return (
            <div key={i} className="pt-1">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                }`}
              >
                {ok ? "completed" : `exited ${exit[1]}`}
              </span>
            </div>
          );
        }
        if (t.startsWith("[engine]") || t.startsWith("[agent error]")) {
          return (
            <p key={i} className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
              {t}
            </p>
          );
        }
        return (
          <p key={i} className="text-xs leading-relaxed text-slate-700">
            {t}
          </p>
        );
      })}
      {running && (
        <p className="pt-1 text-[11px] text-slate-400">
          <span className="mr-1 inline-block animate-pulse text-sky-500">●</span> working…
        </p>
      )}
    </div>
  );
}

export default function WorkflowsPane({
  root,
  onOpenDiff,
  jumpToRun,
  onJumpConsumed,
}: {
  root: string;
  onOpenDiff?: (rel: string, pin?: { base?: string; end?: string }) => void;
  /** Run id to open on arrival (a run started from the chat intake). */
  jumpToRun?: string | null;
  /** Called once the jump target is opened, so it never re-fires. */
  onJumpConsumed?: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [inputs, setInputs] = useState<Record<string, string | boolean>>({});
  const [agent, setAgent] = useState<AgentId>(() => loadDefaultAgent() ?? "claude");
  const [defaultAgent, setDefaultAgent] = useState<AgentId | null>(() => loadDefaultAgent());
  const [roleTab, setRoleTab] = useState<AgentId>(() => loadDefaultAgent() ?? "claude");
  const [run, setRun] = useState<RunState | null>(null);
  const [history, setHistory] = useState<RunState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gateNote, setGateNote] = useState("");
  const [gating, setGating] = useState(false);
  // per-step failure diagnosis (streamed from the agent, read-only)
  const [explain, setExplain] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<string | null>(null);

  async function explainFailure(stepId: string, stepTitle: string, output: string) {
    if (explaining) return;
    setExplaining(stepId);
    setExplain((e) => ({ ...e, [stepId]: "" }));
    try {
      const prompt =
        `A step in a Salesforce delivery workflow failed. Diagnose it. DO NOT modify any files.\n` +
        `Workflow: ${run?.workflowTitle}\nStep: ${stepTitle}\n` +
        `Step output (tail):\n${output.slice(-4000)}\n\n` +
        `Reply with: (1) the root cause in plain language, (2) the exact resolution - ` +
        `commands to run, Setup paths, or what to change - for a Salesforce developer, ` +
        `(3) whether re-running the workflow will then succeed. Be brief and concrete.`;
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, agent, prompt, model: "", readOnly: true }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text();
        setExplain((e) => ({ ...e, [stepId]: `could not diagnose: ${err || res.status}` }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) setExplain((e) => ({ ...e, [stepId]: (e[stepId] ?? "") + chunk }));
      }
      const tail = decoder.decode();
      if (tail) setExplain((e) => ({ ...e, [stepId]: (e[stepId] ?? "") + tail }));
    } catch (err) {
      setExplain((e) => ({ ...e, [stepId]: String(err) }));
    } finally {
      setExplaining(null);
    }
  }
  const [starting, setStarting] = useState(false);
  // monotonically increasing sequence: stale state responses are dropped so a
  // slow poll can never overwrite a fresher post-gate state
  const stateSeq = useRef(0);

  const [roleCfg, setRoleCfg] = useState<Record<string, RoleConfig>>({});
  const [status, setStatus] = useState<Record<
    string,
    { installed?: boolean; tiers?: Record<string, string>; models?: { id: string; label: string }[] }
  > | null>(null);
  const [designing, setDesigning] = useState(false);
  // duplicate-to-customize: the workflow the builder is seeded from
  const [seed, setSeed] = useState<CatalogItem | null>(null);
  const [runFilter, setRunFilter] = useState("");

  /** Filter runs by anything a human would search on: title, status, agent,
   * model, run id, date text, and the run's input content. */
  function matchesFilter(r: RunState): boolean {
    const q = runFilter.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      r.workflowTitle,
      r.status,
      r.agent,
      r.model ?? "",
      r.runId,
      new Date(r.createdAt).toLocaleString(),
      new Date(r.createdAt).toISOString().slice(0, 10),
      ...Object.values(r.inputs ?? {}).map(String),
    ]
      .join(" ")
      .toLowerCase();
    return q.split(/\s+/).every((term) => hay.includes(term));
  }
  // files attached in the start modal - ride into the run's text inputs so
  // agent steps read them (the engine's full-read rule applies)
  const [attachments, setAttachments] = useState<{ rel: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, 8)) {
        const fd = new FormData();
        fd.append("root", root);
        fd.append("file", f);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (res.ok) setAttachments((a) => [...a, { rel: String(data.rel), name: String(data.name) }]);
        else setError(String(data.error ?? "upload failed"));
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function refreshCatalog() {
    const { ok, data } = await api({ action: "list", root });
    if (ok) setCatalog(data.workflows as CatalogItem[]);
  }
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const api = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch("/api/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: `unexpected response (HTTP ${res.status})` };
    }
    return { ok: res.ok, data };
  }, []);

  async function fetchRunState(runId: string) {
    const seq = ++stateSeq.current;
    const { ok, data } = await api({ action: "state", runId });
    if (ok && seq === stateSeq.current) setRun(data as unknown as RunState);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) setRoleCfg(loadRoles());
      fetch("/api/agent-status")
        .then((r) => r.json())
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {});
      const { ok, data } = await api({ action: "list", root });
      if (!cancelled && ok) setCatalog(data.workflows as CatalogItem[]);
      const runsRes = await api({ action: "runs", root });
      if (!cancelled && runsRes.ok) setHistory((runsRes.data.runs as RunState[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, root]);

  // a run started from the chat intake opens directly (consumed exactly once)
  useEffect(() => {
    if (!jumpToRun) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await fetchRunState(jumpToRun);
      onJumpConsumed?.();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, jumpToRun]);

  // poll the active run
  useEffect(() => {
    if (!run || run.status === "done" || run.status === "failed" || run.status === "aborted") {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => {
      void fetchRunState(run.runId);
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // fetchRunState is stable in behavior (api is memoized; seq is a ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, run]);

  function pick(w: CatalogItem) {
    setSelected(w);
    setError(null);
    const init: Record<string, string | boolean> = {};
    for (const i of w.inputs)
      init[i.key] =
        i.default ?? (i.kind === "boolean" ? false : i.kind === "select" ? (i.options?.[0] ?? "") : "");
    setInputs(init);
  }

  /** The input the attach button lives on (and where file refs are appended). */
  function isAttachTarget(i: { key: string; kind: string; attachTo?: boolean }): boolean {
    if (!selected) return false;
    const target =
      selected.inputs.find((x) => x.attachTo) ?? selected.inputs.find((x) => x.kind === "text");
    return target?.key === i.key;
  }

  async function start() {
    if (!selected || starting) return;
    setStarting(true);
    setError(null);
    try {
      // append attached files to the workflow's designated free-text input
      // (attachTo), never to path/list fields; fallback: first text input
      const startInputs = { ...inputs };
      if (attachments.length > 0) {
        const target =
          selected.inputs.find((i) => i.attachTo) ??
          selected.inputs.find((i) => i.kind === "text");
        if (target) {
          startInputs[target.key] =
            `${String(startInputs[target.key] ?? "")}\n\nAttached files (read them from the project root): ${attachments.map((a) => a.rel).join(", ")}`;
        }
      }
      const { ok, data } = await api({
        action: "start",
        root,
        workflow: selected.id,
        inputs: startInputs,
        agent,
        roleModels: rolesFor(agent),
      });
      if (!ok) {
        setError(String(data.error ?? "could not start"));
        return;
      }
      await fetchRunState(String(data.runId));
      setSelected(null);
      setAttachments([]);
    } finally {
      setStarting(false);
    }
  }

  async function gate(decision: "approve" | "abort" | "revise", feedback?: string) {
    if (!run || gating) return;
    setGating(true);
    try {
      const { ok, data } = await api({ action: "gate", runId: run.runId, decision, feedback });
      if (ok && data.resolved === false) {
        alert("The gate is not waiting right now (a revision is replaying or the run ended) - your click was not applied. The view will refresh.");
      }
      setGateNote("");
      await fetchRunState(run.runId);
    } finally {
      setGating(false);
    }
  }

  // ---------- run view ----------
  if (run) {
    const totalIn = run.steps.reduce((n, s) => n + (s.usage?.inTokens ?? 0), 0);
    const totalOut = run.steps.reduce((n, s) => n + (s.usage?.outTokens ?? 0), 0);
    const totalCost = run.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
    return (
      <div className="flex-1 overflow-y-auto p-6">
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
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              run.status === "done"
                ? "bg-emerald-100 text-emerald-700"
                : run.status === "failed" || run.status === "aborted"
                  ? "bg-red-100 text-red-700"
                  : "bg-sky-100 text-sky-700"
            }`}
          >
            {run.status.replace("_", " ")}
          </span>
          <span className="ml-auto font-mono text-[10px] text-slate-400">run {run.runId}</span>
          {(run.status === "running" || run.status === "waiting_gate") && (
            <button
              onClick={async () => {
                if (!confirm("Stop this run? The current step is killed and remaining steps are skipped.")) return;
                await api({ action: "stop", runId: run.runId });
                await fetchRunState(run.runId);
              }}
              className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-600 hover:bg-red-100"
              title="Abort the run - kills the running step's process"
            >
              ■ Stop run
            </button>
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
                if (!ok) alert(String(data.error ?? "cannot resume"));
                else await fetchRunState(run.runId);
              }}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
              title="Re-run from the first incomplete step - completed steps and approved gates are kept"
            >
              ⟳ Resume run
            </button>
          )}
        </div>
        <p className="mb-3 text-[11px] text-slate-500">
          <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 font-medium">
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

        {Object.keys(run.inputs ?? {}).length > 0 && (
          <details className="mb-3 rounded-xl border border-slate-200 bg-white">
            <summary className="cursor-pointer px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-slate-400 hover:text-slate-700">
              Run inputs - what this run was asked to do
            </summary>
            <dl className="space-y-1.5 border-t border-slate-100 px-4 py-2">
              {Object.entries(run.inputs).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{k}</dt>
                  <dd className="whitespace-pre-wrap break-words text-xs text-slate-700">
                    {typeof v === "boolean" ? (v ? "yes" : "no") : String(v).slice(0, 2000)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        {/* the journey at a glance: where the run is, what's left, where the
            human comes in (gates marked). Pure render - zero tokens. */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-y-2">
            {run.steps.map((s, i) => (
              <span key={s.id} className="flex items-center">
                {i > 0 && <span className="mx-1 h-px w-3 bg-slate-200" />}
                <span
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
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
                  {s.type === "gate" ? "🙋" : s.status === "done" ? "✓" : s.status === "failed" ? "✗" : s.status === "running" ? "●" : "○"}
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
                return `🙋 YOUR decision: "${cur.title}" - the run is paused until you act (${doneN}/${run.steps.length} steps done).`;
              if (cur) return `Working: "${cur.title}" (${doneN}/${run.steps.length} steps done). 🙋 marks where you decide.`;
              return `${doneN}/${run.steps.length} steps done.`;
            })()}
          </p>
        </div>

        <div className="space-y-2">
          {run.steps.map((s) => (
            <details
              key={s.id}
              open={s.status === "running" || s.status === "waiting_gate" || s.status === "failed"}
              className={`rounded-xl border border-l-4 bg-white ${
                STATUS_EDGE[s.status] ?? "border-l-slate-200"
              } ${
                s.status === "waiting_gate" ? "border-amber-300 ring-1 ring-amber-200" : "border-slate-200"
              }`}
            >
              <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm">
                <span>{STATUS_ICON[s.status]}</span>
                <span className={s.status === "skipped" ? "text-slate-400" : "font-medium"}>
                  {s.title}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  {s.type === "agent" && s.model && s.model !== "default" && (
                    <span
                      className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-500"
                      title={s.modelFrom ? `model source: ${s.modelFrom}` : undefined}
                    >
                      {s.model}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
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
                      : reviewer.output.slice(-3000);
                    return (
                      <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-red-600">
                          Reviewer findings - still BLOCKED after the auto-fix round
                        </p>
                        <pre className="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/60 p-2 text-xs text-slate-700">
                          {findings}
                        </pre>
                        <button
                          onClick={() =>
                            gate(
                              "revise",
                              `Address EVERY blocking finding from the design reviewer, exactly as each Fix line specifies. Do not re-argue a finding - implement its fix or state explicitly why it is impossible:\n\n${findings.slice(0, 11000)}`,
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
                    const source = [...segment]
                      .reverse()
                      .find((x) => x.type === "agent" && x.output.includes("### REQ-"));
                    if (!source) return null;
                    const items = parseRequirements(source.output);
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
                        onApproveAll={() => gate("approve")}
                        onSubmit={(instruction) => gate("revise", instruction)}
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
                      onClick={() => gate("approve")}
                      disabled={gating}
                      className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                    >
                      {gating ? "…" : "Approve & continue"}
                    </button>
                    <button
                      onClick={() => gate("revise", gateNote)}
                      disabled={gating || !gateNote.trim()}
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
                  // never show "working…" unless the RUN itself is still live
                  running={
                    s.status === "running" &&
                    (run.status === "running" || run.status === "waiting_gate")
                  }
                />
              )}
              {s.status === "failed" && s.output && (
                <div className="border-t border-slate-100 px-4 py-2">
                  {explain[s.id] === undefined ? (
                    <button
                      onClick={() => explainFailure(s.id, s.title, s.output)}
                      disabled={explaining !== null}
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                    >
                      {explaining === s.id ? "Diagnosing…" : "🛟 Explain & suggest fix"}
                    </button>
                  ) : (
                    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-600">
                        Diagnosis ({agent})
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-xs text-slate-700">
                        {explain[s.id] || "analysing…"}
                      </pre>
                    </div>
                  )}
                </div>
              )}
              {s.usage && (
                <p className="border-t border-slate-100 px-4 py-1.5 text-[10px] text-slate-400">
                  {s.model && (
                    <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5" title={s.modelFrom ? `model source: ${s.modelFrom}` : undefined}>
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
                      className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-slate-100"
                      title="Open diff"
                    >
                      <span className="mr-2 text-[10px] font-semibold uppercase text-amber-600">
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

  // ---------- catalog + start form ----------
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-sm font-semibold text-slate-700">Delivery workflows</h2>
      <p className="mt-1 text-xs text-slate-500">
        Deterministic step-by-step paths. Agents act only inside gated steps; everything is logged
        to the run history.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <details className="mt-4 rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-800">
          Models by role - which model plays each role, per agent
        </summary>
        <div className="space-y-4 border-t border-slate-100 p-4">
          <p className="text-[11px] text-slate-400">
            Every workflow step plays one of five roles; set the model per role once and every
            workflow follows - no per-run input needed. Empty = automatic (the shipped default
            shown as placeholder). A change here applies from the next run.
          </p>
          <div className="flex gap-1.5">
            {AGENT_OPTIONS.map((a) => (
              <button
                key={a.id}
                onClick={() => setRoleTab(a.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  roleTab === a.id
                    ? "border-slate-900 bg-slate-900 text-white"
                    : defaultAgent === a.id
                      ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                }`}
              >
                {a.label}
                {defaultAgent === a.id && <span className="ml-1.5 text-[10px]">★ default</span>}
              </button>
            ))}
          </div>
          {(() => {
            const s = status?.[roleTab];
            const cfg = roleCfg[roleTab] ?? {};
            return (
              <div>
                <datalist id={`models-${roleTab}`}>
                  {[
                    ...(s?.models ?? []).map((m) => m.id).filter(Boolean),
                    ...loadCustomModels(roleTab),
                  ].map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
                <label className="flex w-fit cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
                  <input
                    type="checkbox"
                    checked={defaultAgent === roleTab}
                    onChange={(e) => {
                      const v = e.target.checked ? roleTab : null;
                      saveDefaultAgent(v);
                      setDefaultAgent(v);
                      if (v) setAgent(v);
                    }}
                  />
                  Default agent - preselected for chat and every new run
                </label>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  {STEP_ROLES.map((role) => {
                    const val = cfg[role]?.trim() ?? "";
                    const set = !!val;
                    // must be an exact CLI model slug - the server DROPS
                    // anything else, so warn loudly instead of failing silently
                    const invalid = set && !/^[A-Za-z0-9._-]{1,60}$/.test(val);
                    return (
                      <label key={role} className="block">
                        <span className="text-[11px] font-medium text-slate-500">{ROLE_LABEL[role]}</span>
                        <input
                          value={cfg[role] ?? ""}
                          list={`models-${roleTab}`}
                          onChange={(e) => {
                            const all = loadRoles();
                            all[roleTab] = { ...all[roleTab], [role]: e.target.value.trim() };
                            saveRoles(all);
                            setRoleCfg(all);
                          }}
                          onBlur={(e) => {
                            let v = e.target.value.trim();
                            // model ids are case-sensitive at the CLI - when the
                            // typed value matches a known id except for case,
                            // auto-correct instead of failing at run time
                            const known = [
                              ...(s?.models ?? []).map((m) => m.id),
                              ...loadCustomModels(roleTab),
                            ].filter(Boolean);
                            const match = known.find(
                              (id) => id.toLowerCase() === v.toLowerCase() && id !== v,
                            );
                            if (match) {
                              v = match;
                              const all = loadRoles();
                              all[roleTab] = { ...all[roleTab], [role]: v };
                              saveRoles(all);
                              setRoleCfg(all);
                            }
                            // a completed custom id becomes a suggestion everywhere
                            if (v && !known.includes(v)) {
                              addCustomModel(roleTab, v);
                            }
                          }}
                          placeholder={s?.tiers?.[ROLE_TIER[role]] || "cli default"}
                          spellCheck={false}
                          className={`mt-1 block w-full rounded-lg border px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-slate-400 ${
                            invalid
                              ? "border-red-400 bg-red-50/50"
                              : set
                                ? "border-sky-200 bg-sky-50/40"
                                : "border-slate-200"
                          }`}
                        />
                        {invalid && (
                          <span className="mt-0.5 block text-[10px] font-medium text-red-600">
                            not a model id (letters/digits/dots/dashes only - no spaces) - would
                            be IGNORED at run time
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          <p className="text-[10px] text-slate-400">
            Roles → steps: Read/investigate = locate, plan, assess · Design/author = analyse, spec,
            write-doc · Implement = implement (all workflows) · Review = design-review, code review ·
            Trace/coverage = coverage-check, traceability.
          </p>
        </div>
      </details>

      {history.length > 0 && (
        <details className="mt-4 rounded-xl border border-slate-200 bg-white">
          <summary className="flex cursor-pointer items-center px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-800">
            Recent runs ({history.length})
            <span className="ml-auto font-normal normal-case tracking-normal text-slate-400">
              total {fmtCost(history.reduce((n, r) => n + runCost(r), 0))} at API rates
            </span>
          </summary>
          <div className="space-y-1 border-t border-slate-100 p-3">
            <input
              value={runFilter}
              onChange={(e) => setRunFilter(e.target.value)}
              placeholder="Filter runs - text, status, agent, date (e.g. 2026-08-26), or words from the request…"
              spellCheck={false}
              className="mb-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
            />
            {history.filter(matchesFilter).length === 0 && (
              <p className="px-2 py-1 text-xs text-slate-400">no runs match</p>
            )}
            {history.filter(matchesFilter).map((r) => (
              <button
                key={r.runId}
                onClick={() => setRun(r)}
                className={`flex w-full items-center gap-3 rounded-lg border border-l-4 border-slate-200 bg-white px-3 py-2 text-left text-xs hover:border-slate-400 ${
                  r.status === "done"
                    ? "border-l-emerald-400"
                    : r.status === "running" || r.status === "waiting_gate"
                      ? "border-l-sky-400"
                      : "border-l-red-300"
                }`}
              >
                <span className="font-medium">{r.workflowTitle}</span>
                <span className="text-slate-400">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                  {r.agent}
                  {r.model ? ` · ${r.model}` : ""}
                </span>
                {runCost(r) > 0 && (
                  <span className="text-[10px] text-slate-400">{fmtCost(runCost(r))}</span>
                )}
                <span
                  className={`ml-auto text-[10px] font-semibold uppercase ${
                    r.status === "done"
                      ? "text-emerald-600"
                      : r.status === "running" || r.status === "waiting_gate"
                        ? "text-sky-600"
                        : "text-red-500"
                  }`}
                >
                  {r.status.replace("_", " ")}
                </span>
              </button>
            ))}
          </div>
        </details>
      )}

      {CATEGORIES.map(([label, ids]) => {
        const items = (catalog ?? []).filter((w) =>
          label === "Custom" ? w.custom : !w.custom && ids.includes(w.id),
        );
        const uncategorized =
          label === "Custom"
            ? []
            : (catalog ?? []).filter(
                (w) => !w.custom && !CATEGORIES.some(([, x]) => x.includes(w.id)),
              );
        const list = label === CATEGORIES[0][0] ? [...items, ...uncategorized] : items;
        if (list.length === 0 && label !== "Custom") return null;
        return (
          <div key={label} className="mt-5">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              {label}
            </h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((w) => (
                <div
                  key={w.id}
                  className={`group relative rounded-xl border bg-white transition-all hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md ${
                    selected?.id === w.id
                      ? "border-slate-900 ring-2 ring-slate-900/10"
                      : "border-slate-200"
                  }`}
                >
                  <button onClick={() => pick(w)} className="w-full p-4 text-left">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {w.title}
                      {w.custom && (
                        <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-600">
                          {w.scope === "project" ? "custom · this project" : "custom · all projects"}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-3 text-xs text-slate-500">{w.description}</p>
                  </button>
                  <span className="absolute right-2 top-2 flex gap-0.5">
                    <button
                      onClick={() => {
                        setSeed(w);
                        setDesigning(true);
                      }}
                      className="rounded px-1.5 text-xs text-slate-300 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100"
                      title="Duplicate to customize - copy this workflow and add/remove steps on top"
                    >
                      ⧉
                    </button>
                    {w.custom && (
                      <button
                        onClick={async () => {
                          await api({ action: "delete-custom", root, workflow: w.id });
                          if (selected?.id === w.id) setSelected(null);
                          refreshCatalog();
                        }}
                        className="rounded px-1.5 text-xs text-slate-300 hover:bg-red-50 hover:text-red-500"
                        title="Delete this custom workflow"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {label === "Custom" && (
                <button
                  onClick={() => {
                    setSeed(null);
                    setDesigning(true);
                  }}
                  className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-left text-slate-400 transition-all hover:-translate-y-0.5 hover:border-slate-500 hover:text-slate-600 hover:shadow-md"
                >
                  <div className="text-sm font-semibold">+ Design a workflow</div>
                  <p className="mt-1 text-xs">
                    Build your own step sequence - same engine, gates, and audit.
                  </p>
                </button>
              )}
            </div>
          </div>
        );
      })}
      {catalog === null && <p className="mt-4 text-xs text-slate-400">loading…</p>}

      {designing && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6"
          onClick={(e) => e.target === e.currentTarget && setDesigning(false)}
        >
          <div className="w-full max-w-3xl">
            <WorkflowBuilder
              root={root}
              seed={seed as unknown as BuilderSeed | null}
              onCancel={() => setDesigning(false)}
              onSaved={() => {
                setDesigning(false);
                refreshCatalog();
              }}
            />
          </div>
        </div>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6"
          onClick={(e) => e.target === e.currentTarget && !starting && setSelected(null)}
        >
          <div className="mt-10 w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">{selected.title}</h3>
                <p className="mt-0.5 text-xs text-slate-500">{selected.description}</p>
              </div>
              <button
                onClick={() => !starting && setSelected(null)}
                className="rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                title="Close"
              >
                ✕
              </button>
            </div>
            <div className="mt-4 space-y-3">
            {selected.inputs.filter((i) => !i.hidden).map((i) =>
              i.kind === "boolean" ? (
                <label key={i.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={inputs[i.key] === true}
                    onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.checked }))}
                  />
                  {i.label}
                </label>
              ) : i.kind === "select" ? (
                <div key={i.key}>
                  <label className="text-xs font-medium text-slate-500">{i.label}</label>
                  <select
                    value={String(inputs[i.key] ?? "")}
                    onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.value }))}
                    className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                  >
                    {(i.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div key={i.key}>
                  <label className="text-xs font-medium text-slate-500">{i.label}</label>
                  <div className="relative mt-1">
                    <textarea
                      value={String(inputs[i.key] ?? "")}
                      onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.value }))}
                      rows={3}
                      className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 ${
                        isAttachTarget(i) ? "pr-10" : ""
                      }`}
                    />
                    {isAttachTarget(i) && (
                      <button
                        onClick={() => fileRef.current?.click()}
                        disabled={uploading || starting}
                        className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-40"
                        title="Attach requirement documents, screenshots, or logs - the AI reads them in full"
                      >
                        {uploading ? (
                          <span className="text-xs">…</span>
                        ) : (
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <path d="M8 3v10M3 8h10" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                  {isAttachTarget(i) && attachments.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {attachments.map((a) => (
                        <span
                          key={a.rel}
                          className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600"
                        >
                          {a.name}
                          <button
                            onClick={() => setAttachments((x) => x.filter((y) => y.rel !== a.rel))}
                            className="text-slate-400 hover:text-slate-700"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ),
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.doc,.txt,.log,.csv,.md"
              className="hidden"
              onChange={(e) => uploadFiles(e.target.files)}
            />
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-500">Agent:</label>
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value as AgentId)}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
              >
                {AGENT_OPTIONS.map((a) => (
                  <option key={a.id} value={a.id} disabled={status?.[a.id]?.installed === false}>
                    {a.label}
                    {defaultAgent === a.id ? " ★ (default)" : ""}
                    {status?.[a.id]?.installed === false ? " - not installed" : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={() => !starting && setSelected(null)}
                className="ml-auto rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={start}
                disabled={starting}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {starting ? "Starting…" : "Start run"}
              </button>
            </div>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
