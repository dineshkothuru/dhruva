"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents";
import type { RunState } from "@/lib/workflows/schema";
import CliResult from "@/components/workflows/CliResult";
import { loadTiers, saveTiers, tiersFor, type TierConfig } from "@/lib/tierStore";
import WorkflowBuilder from "@/components/workflows/WorkflowBuilder";

interface CatalogItem {
  id: string;
  title: string;
  description: string;
  custom?: boolean;
  inputs: {
    key: string;
    label: string;
    kind: "text" | "boolean" | "select";
    options?: string[];
    default?: string | boolean;
    attachTo?: boolean;
  }[];
}

/** Catalog grouping — anything unlisted lands in the first group. */
const CATEGORIES: [string, string[]][] = [
  ["Development", ["bug-fix", "feature-dev", "solution-design", "implement-tdd"]],
  ["Testing", ["test-gen", "run-tests"]],
  ["Org & deployment", ["retrieve-sync", "deploy-preview", "validate-deploy", "scratch-org"]],
  ["Custom", []],
];

const AGENT_OPTIONS: { id: AgentId; label: string }[] = [
  { id: "copilot", label: "GitHub Copilot" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "OpenAI Codex" },
];

const STATUS_ICON: Record<string, string> = {
  pending: "◻",
  running: "⏳",
  waiting_gate: "✋",
  done: "✅",
  failed: "❌",
  skipped: "⤼",
};

/** Colored left edge per step status — the run's frontier at a glance. */
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
        running — output streams here…
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
  onOpenDiff?: (rel: string) => void;
  /** Run id to open on arrival (a run started from the chat intake). */
  jumpToRun?: string | null;
  /** Called once the jump target is opened, so it never re-fires. */
  onJumpConsumed?: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [inputs, setInputs] = useState<Record<string, string | boolean>>({});
  const [agent, setAgent] = useState<AgentId>("claude");
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
        `Reply with: (1) the root cause in plain language, (2) the exact resolution — ` +
        `commands to run, Setup paths, or what to change — for a Salesforce developer, ` +
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

  const [tierCfg, setTierCfg] = useState<Record<string, TierConfig>>({});
  const [status, setStatus] = useState<Record<
    string,
    { tiers?: Record<string, string> }
  > | null>(null);
  const [designing, setDesigning] = useState(false);
  // files attached in the start modal — ride into the run's text inputs so
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
      if (!cancelled) setTierCfg(loadTiers());
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
        tiers: tiersFor(agent),
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
      await api({ action: "gate", runId: run.runId, decision, feedback });
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
              rates (runs on your subscription — not billed)
            </>
          )}
        </p>

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
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    TYPE_CHIP[s.type] ?? "bg-slate-100 text-slate-500"
                  }`}
                >
                  {s.type}
                </span>
              </summary>
              {s.status === "waiting_gate" ? (
                <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="whitespace-pre-wrap text-sm text-amber-800">{s.output}</p>
                  <textarea
                    value={gateNote}
                    onChange={(e) => setGateNote(e.target.value)}
                    rows={2}
                    placeholder="Optional instructions — e.g. 'use a flow instead of a trigger', 'split the service class'. Filling this enables Revise: the previous analysis re-runs following your instructions, then gates again."
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
                <StepBody output={s.output} type={s.type} running={s.status === "running"} />
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
                  {s.model && <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5">{s.model}</span>}
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
                      onClick={() => onOpenDiff?.(c.file)}
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
          Model tiers — which model runs judgment vs coding steps
        </summary>
        <div className="space-y-3 border-t border-slate-100 p-4">
          <p className="text-[11px] text-slate-400">
            <span className="font-medium">best</span> runs analysis/design/review/traceability
            steps; <span className="font-medium">default</span> runs implementation;{" "}
            <span className="font-medium">light</span> is reserved for cheap mechanical steps.
            Empty = the shipped default shown as placeholder. Pick models your org policy allows.
          </p>
          {AGENT_OPTIONS.map((a) => {
            const s = status?.[a.id];
            const cfg = tierCfg[a.id] ?? {};
            return (
              <div key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="w-28 text-xs font-medium text-slate-600">{a.label}</span>
                {(["best", "default", "light"] as const).map((tier) => (
                  <label key={tier} className="flex items-center gap-1 text-[11px] text-slate-400">
                    {tier}
                    <input
                      value={cfg[tier] ?? ""}
                      onChange={(e) => {
                        const all = loadTiers();
                        all[a.id] = { ...all[a.id], [tier]: e.target.value.trim() };
                        saveTiers(all);
                        setTierCfg(all);
                      }}
                      placeholder={s?.tiers?.[tier] || "cli default"}
                      spellCheck={false}
                      className="w-36 rounded-lg border border-slate-200 px-2 py-1 font-mono text-[11px] outline-none focus:border-slate-400"
                    />
                  </label>
                ))}
              </div>
            );
          })}
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
            {history.map((r) => (
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
                          custom
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-3 text-xs text-slate-500">{w.description}</p>
                  </button>
                  {w.custom && (
                    <button
                      onClick={async () => {
                        await api({ action: "delete-custom", root, workflow: w.id });
                        if (selected?.id === w.id) setSelected(null);
                        refreshCatalog();
                      }}
                      className="absolute right-2 top-2 rounded px-1.5 text-xs text-slate-300 hover:bg-red-50 hover:text-red-500"
                      title="Delete this custom workflow"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {label === "Custom" && (
                <button
                  onClick={() => setDesigning(true)}
                  className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-left text-slate-400 transition-all hover:-translate-y-0.5 hover:border-slate-500 hover:text-slate-600 hover:shadow-md"
                >
                  <div className="text-sm font-semibold">+ Design a workflow</div>
                  <p className="mt-1 text-xs">
                    Build your own step sequence — same engine, gates, and audit.
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
            {selected.inputs.map((i) =>
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
                        title="Attach requirement documents, screenshots, or logs — the AI reads them in full"
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
                  <option key={a.id} value={a.id}>
                    {a.label}
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
