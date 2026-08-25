"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents";
import type { RunState } from "@/lib/workflows/schema";
import CliResult from "@/components/CliResult";

interface CatalogItem {
  id: string;
  title: string;
  description: string;
  inputs: {
    key: string;
    label: string;
    kind: "text" | "boolean" | "select";
    options?: string[];
    default?: string | boolean;
  }[];
}

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
}: {
  root: string;
  onOpenDiff?: (rel: string) => void;
  /** Run id to open on arrival (a run started from the chat intake). */
  jumpToRun?: string | null;
}) {
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [inputs, setInputs] = useState<Record<string, string | boolean>>({});
  const [agent, setAgent] = useState<AgentId>("claude");
  const [run, setRun] = useState<RunState | null>(null);
  const [history, setHistory] = useState<RunState[]>([]);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { ok, data } = await api({ action: "list" });
      if (!cancelled && ok) setCatalog(data.workflows as CatalogItem[]);
      const runsRes = await api({ action: "runs", root });
      if (!cancelled && runsRes.ok) setHistory((runsRes.data.runs as RunState[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, root]);

  // a run started from the chat intake opens directly
  useEffect(() => {
    if (!jumpToRun) return;
    let cancelled = false;
    (async () => {
      const { ok, data } = await api({ action: "state", runId: jumpToRun });
      if (!cancelled && ok) setRun(data as unknown as RunState);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, jumpToRun]);

  // poll the active run
  useEffect(() => {
    if (!run || run.status === "done" || run.status === "failed" || run.status === "aborted") {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(async () => {
      const { ok, data } = await api({ action: "state", runId: run.runId });
      if (ok) setRun(data as unknown as RunState);
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
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

  async function start() {
    if (!selected) return;
    setError(null);
    const { ok, data } = await api({ action: "start", root, workflow: selected.id, inputs, agent });
    if (!ok) {
      setError(String(data.error ?? "could not start"));
      return;
    }
    const st = await api({ action: "state", runId: data.runId });
    if (st.ok) setRun(st.data as unknown as RunState);
    setSelected(null);
  }

  async function gate(approve: boolean) {
    if (!run) return;
    await api({ action: "gate", runId: run.runId, approve });
    const st = await api({ action: "state", runId: run.runId });
    if (st.ok) setRun(st.data as unknown as RunState);
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
                  <p className="text-sm text-amber-800">{s.output}</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => gate(true)}
                      className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
                    >
                      Approve & continue
                    </button>
                    <button
                      onClick={() => gate(false)}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs font-medium hover:bg-slate-50"
                    >
                      Abort run
                    </button>
                  </div>
                </div>
              ) : (
                <StepBody output={s.output} type={s.type} running={s.status === "running"} />
              )}
              {s.usage && (
                <p className="border-t border-slate-100 px-4 py-1.5 text-[10px] text-slate-400">
                  ~{s.usage.inTokens.toLocaleString()} in / {s.usage.outTokens.toLocaleString()} out
                  tokens · $
                  {s.usage.costUsd < 0.01 ? s.usage.costUsd.toFixed(4) : s.usage.costUsd.toFixed(2)}{" "}
                  (est. at API rates)
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
                className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs hover:border-slate-400"
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

      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
        {(catalog ?? []).map((w) => (
          <button
            key={w.id}
            onClick={() => pick(w)}
            className={`rounded-xl border p-4 text-left hover:border-slate-400 ${
              selected?.id === w.id ? "border-slate-900 bg-white" : "border-slate-200 bg-white"
            }`}
          >
            <div className="text-sm font-semibold">{w.title}</div>
            <p className="mt-1 text-xs text-slate-500">{w.description}</p>
          </button>
        ))}
        {catalog === null && <p className="text-xs text-slate-400">loading…</p>}
      </div>

      {selected && (
        <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold">{selected.title}</h3>
          <div className="mt-3 space-y-3">
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
                  <textarea
                    value={String(inputs[i.key] ?? "")}
                    onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.value }))}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                  />
                </div>
              ),
            )}
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
                onClick={start}
                className="ml-auto rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                Start run
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
