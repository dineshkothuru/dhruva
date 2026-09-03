"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents";
import { chainState, groupRunsByChain } from "@/lib/chains";
import type { RunState } from "@/lib/workflows/schema";
import { Icon } from "@/components/icons";
import { AGENT_OPTIONS, CATEGORIES, fmtCost, runCost } from "@/components/workflows/StepTrace";
import { ROLE_META, wfIdentity, type CatalogItem } from "@/components/workflows/workflowsShared";
// re-exported so existing importers (tests) keep working after the extraction
export { stepRows, type StepRow } from "@/components/workflows/workflowsShared";

import { loadRoles, saveRoles, rolesFor, type RoleConfig } from "@/lib/roleStore";
import { STEP_ROLES, ROLE_LABEL, ROLE_TIER } from "@/lib/workflows/schema";
import { loadDefaultAgent, saveDefaultAgent } from "@/lib/agentStore";
import { loadCustomModels, addCustomModel } from "@/lib/modelStore";
import WorkflowBuilder, { type BuilderSeed } from "@/components/workflows/WorkflowBuilder";
import RunView from "@/components/workflows/RunView";




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
  // results that used to go to window.alert, which the app shell suppresses
  const [notice, setNotice] = useState<string | null>(null);
  const [gateNote, setGateNote] = useState("");
  const [gating, setGating] = useState(false);
  // Documents a step wrote, by project-relative path. The gate renders its
  // cards from the DESIGN, not from the step's output: once the designer sends
  // a delta, that output is only the blocks it changed, and cards built from
  // it would show three requirements and imply the other thirty-one had gone.
  const [docs, setDocs] = useState<Record<string, string>>({});
  // The per-requirement rulings, held HERE rather than inside the cards, so the
  // gate's own buttons below them send the same marks the cards' button would.
  const [cards, setCards] = useState<{ id: string; verdict: "approve" | "revise"; note?: string }[]>([]);
  // The rulings belong to ONE gate of ONE run. Without this reset, marks made
  // at run A's design gate rode into run B (opened from history) or into a
  // later cards-less gate of the same run - where "Approve & continue" would
  // send the stale rulings, the engine would convert the approval into a
  // revise (cards.revising wins), and the wrong REQ verdicts would be written
  // into whichever design doc THAT gate targets.
  const waitingGateId =
    run?.status === "waiting_gate"
      ? (run.steps.find((s) => s.status === "waiting_gate")?.id ?? null)
      : null;
  useEffect(() => {
    setCards([]);
    setGateNote("");
  }, [run?.runId, waitingGateId]);
  // per-step failure diagnosis (streamed from the agent, read-only)
  const [explain, setExplain] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<string | null>(null);

  async function explainFailure(rawStepId: string, stepTitle: string, output: string) {
    const stepId = `${run?.runId}:${rawStepId}`;
    if (explaining) return;
    setExplaining(stepId);
    setExplain((e) => ({ ...e, [stepId]: "" }));
    try {
      const prompt =
        `A step in a Salesforce delivery workflow failed. Diagnose it. DO NOT modify any files.\n` +
        `Workflow: ${run?.workflowTitle}\nStep: ${stepTitle}\n` +
        `Step output:\n${output}\n\n` +
        `Reply with: (1) the root cause in plain language, (2) the exact resolution - ` +
        `commands to run, Setup paths, or what to change - for a Salesforce developer, ` +
        `(3) whether re-running the workflow will then succeed. Be brief and concrete.`;
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // the RUN's agent, not the start-form selection: a diagnosis labeled
        // with (and executed by) an agent that never ran this workflow is
        // wrong twice - and may not even be installed
        body: JSON.stringify({ root, agent: run?.agent ?? agent, prompt, model: "", readOnly: true }),
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

  /** Open any run by id - live runs come from engine memory; finished runs
   * that only exist on disk come from the runs listing. Used by the chain
   * rail to hop between a chain's phases. */
  async function openRunById(runId: string) {
    const seq = ++stateSeq.current;
    const { ok, data } = await api({ action: "state", runId });
    if (ok) {
      if (seq === stateSeq.current) setRun(data as unknown as RunState);
      return;
    }
    const r = await api({ action: "runs", root });
    if (r.ok && seq === stateSeq.current) {
      const found = ((r.data.runs as RunState[]) ?? []).find((x) => x.runId === runId);
      if (found) setRun(found);
    }
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

  // Keep the documents this run's steps wrote in sync with the run state, so
  // the gate always renders the design as it stands rather than the last delta.
  //
  // Keyed on what actually changes a document - which steps wrote one, and
  // each step's status and attempt count - rather than on `run.steps`, which
  // is a fresh array on every poll and would re-fetch every second forever.
  const docKey = (run?.steps ?? [])
    .filter((s) => s.artifact)
    .map((s) => `${s.artifact}:${s.status}:${s.attempts?.length ?? 0}`)
    .join("|");
  useEffect(() => {
    const paths = [...new Set(docKey.split("|").filter(Boolean).map((k) => k.split(":")[0]))];
    if (paths.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const rel of paths) {
        const res = await fetch("/api/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root, file: rel, action: "read" }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (cancelled) return;
        if (typeof res?.content === "string") {
          setDocs((prev) => (prev[rel] === res.content ? prev : { ...prev, [rel]: res.content }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, docKey]);

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

  // poll the active run.
  //
  // A finished run normally stops the poll - but a run that is part of a
  // CHAIN is not the end of the story. The engine marks it done, persists,
  // and only then starts the next phase and records its id. A poll landing in
  // that window would see "done", stop, and leave the chain rail claiming the
  // next phase is still queued while it is actually running. So keep polling
  // a finished run until the next link has an id to point at.
  const chainHasUnstartedNext =
    !!run?.chain &&
    (run.chainIndex ?? 0) < run.chain.length - 1 &&
    !run.chain[(run.chainIndex ?? 0) + 1]?.runId;
  useEffect(() => {
    const settled =
      run && (run.status === "done" || run.status === "failed" || run.status === "aborted");
    // a failed or aborted run pauses the chain, so only a clean finish waits
    const waitingForNextPhase = run?.status === "done" && chainHasUnstartedNext;
    if (!run || (settled && !waitingForNextPhase)) {
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
  }, [api, run, chainHasUnstartedNext]);

  function pick(w: CatalogItem) {
    setSelected(w);
    setError(null);
    const init: Record<string, string | boolean> = {};
    for (const i of w.inputs)
      init[i.key] =
        i.default ?? (i.kind === "boolean" ? false : i.kind === "select" ? (i.options?.[0] ?? "") : "");
    setInputs(init);
  }

  /** Close the start form and delete anything staged but never used.
   *
   * The modal used to just clear its state, so a file attached and then
   * abandoned stayed on disk forever - the reason one project accumulated
   * thirteen copies of one document. A run that DID start has already moved
   * what it referenced into its own folder, so nothing it owns is at risk. */
  const closeStartForm = useCallback(() => {
    const names = attachments
      .map((a) => a.rel)
      .filter((r) => r.startsWith(".dhruva/tmp/attachments/"))
      .map((r) => r.split("/").pop() ?? "")
      .filter(Boolean);
    setSelected(null);
    setAttachments([]);
    if (names.length > 0 && root) {
      void fetch("/api/upload/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, names }),
      }).catch(() => {});
    }
  }, [attachments, root]);

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

  async function gate(
    decision: "approve" | "abort" | "revise" | "park",
    feedback?: string,
    cards?: { id: string; verdict: "approve" | "revise"; note?: string }[],
  ) {
    if (!run || gating) return;
    setGating(true);
    try {
      const { ok, data } = await api({ action: "gate", runId: run.runId, decision, feedback, cards });
      if (!ok) {
        // an HTTP failure must not silently swallow the click - and it must
        // NOT clear the textarea holding the user's typed revise instructions
        setError(
          `Gate decision was not applied: ${String((data as { error?: string })?.error ?? "request failed")}. ` +
            "Your notes are kept - try again.",
        );
        await fetchRunState(run.runId);
        return;
      }
      if (data.resolved === false) {
        setError(
          "The gate is not waiting right now (a revision is replaying or the run ended) - " +
            "your click was not applied. The view will refresh.",
        );
      }
      setGateNote("");
      await fetchRunState(run.runId);
    } finally {
      setGating(false);
    }
  }

  // ---------- run view ----------
  // ---------- run view (extracted to RunView.tsx - pure move) ----------
  if (run) {
    return (
      <RunView
        root={root}
        run={run}
        agent={agent}
        api={api}
        gate={gate}
        gating={gating}
        gateNote={gateNote}
        setGateNote={setGateNote}
        cards={cards}
        setCards={setCards}
        docs={docs}
        explain={explain}
        explaining={explaining}
        explainFailure={explainFailure}
        fetchRunState={fetchRunState}
        openRunById={openRunById}
        setRun={setRun}
        setHistory={setHistory}
        error={error}
        setError={setError}
        notice={notice}
        setNotice={setNotice}
        onOpenDiff={onOpenDiff}
      />
    );
  }

  // ---------- catalog + start form ----------
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-base font-semibold tracking-tight text-slate-800">Delivery workflows</h2>
      <div className="mt-1.5 h-0.5 w-10 rounded-full bg-gradient-to-r from-indigo-500 to-sky-400" />
      <p className="mt-1 text-xs text-slate-500">
        Deterministic step-by-step paths. Agents act only inside gated steps; everything is logged
        to the run history.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {notice && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
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

      <details className="mt-4 rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-800">
          {<Icon.models size={12} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} Models by role - which model plays each role, per agent
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
                {defaultAgent === a.id && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px]"><Icon.star size={10} strokeWidth={2} className="fill-current" /> default</span>}
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
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {STEP_ROLES.map((role) => {
                    const val = cfg[role]?.trim() ?? "";
                    const set = !!val;
                    const invalid = set && !/^[A-Za-z0-9._-]{1,60}$/.test(val);
                    const rm = ROLE_META[role];
                    const autoModel = s?.tiers?.[ROLE_TIER[role]] || "cli default";
                    return (
                      <div key={role} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md">
                        <div className="flex items-center gap-2">
                          <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${rm.tint}`}>
                            <rm.icon size={14} strokeWidth={1.75} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-800">{ROLE_LABEL[role]}</p>
                            <p className="truncate text-[11px] text-slate-400">{rm.blurb}</p>
                          </div>
                        </div>
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
                            const known = [...(s?.models ?? []).map((m) => m.id), ...loadCustomModels(roleTab)].filter(Boolean);
                            const match = known.find((id) => id.toLowerCase() === v.toLowerCase() && id !== v);
                            if (match) {
                              v = match;
                              const all = loadRoles();
                              all[roleTab] = { ...all[roleTab], [role]: v };
                              saveRoles(all);
                              setRoleCfg(all);
                            }
                            if (v && !known.includes(v)) addCustomModel(roleTab, v);
                          }}
                          placeholder={autoModel}
                          spellCheck={false}
                          className={`mt-2.5 block w-full rounded-lg border px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-slate-400 ${
                            invalid ? "border-red-400 bg-red-50/50" : set ? "border-sky-200 bg-sky-50/40" : "border-slate-200"
                          }`}
                        />
                        <p className="mt-1 text-[11px] text-slate-400">
                          {invalid ? (
                            <span className="font-semibold text-red-600">not a model id (no spaces) - would be IGNORED</span>
                          ) : set ? (
                            <span className="text-sky-600">your setting</span>
                          ) : (
                            <>auto · {autoModel}</>
                          )}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1 border-t border-slate-100 pt-1.5">
                          {rm.steps.map((st) => (
                            <span key={st} className="rounded-md bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-500">{st}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        </div>
      </details>

      {history.length > 0 && (
        <details className="mt-4 rounded-xl border border-slate-200 bg-white">
          <summary className="flex cursor-pointer items-center px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-800">
            {<Icon.history size={12} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} Recent runs ({history.length})
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
            {groupRunsByChain(history.filter(matchesFilter)).map((g) => {
              const head = g.runs[g.runs.length - 1];
              const plan = head.chain;
              const isChain = !!plan && plan.length > 1;
              const cost = g.runs.reduce((n, r) => n + runCost(r), 0);
              // the chain's overall state: live if any phase is, else the
              // furthest phase's own outcome
              const broke = g.runs.find((r) => r.status === "failed" || r.status === "aborted");
              const state = chainState(g);
              const byId = new Map(g.runs.map((r) => [r.runId, r]));

              return (
                <div
                  key={g.key}
                  className={`rounded-lg border border-l-4 border-slate-200 bg-white ${
                    state === "done"
                      ? "border-l-emerald-400"
                      : state === "running" || state === "waiting_gate"
                        ? "border-l-sky-400"
                        : "border-l-red-300"
                  }`}
                >
                  <button
                    onClick={() => setRun(head)}
                    className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 text-left text-xs hover:bg-slate-50"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {isChain ? plan!.map((c) => c.title).join(" -> ") : head.workflowTitle}
                    </span>
                    {isChain && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-600">
                        <Icon.chain size={11} strokeWidth={1.75} />
                        {plan!.filter((c) => byId.get(c.runId ?? "")?.status === "done").length}/
                        {plan!.length}
                      </span>
                    )}
                    <span className="hidden shrink-0 text-slate-400 sm:inline">
                      {new Date(head.createdAt).toLocaleString()}
                    </span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                      {head.agent}
                      {head.model ? ` \u00b7 ${head.model}` : ""}
                    </span>
                    {cost > 0 && (
                      <span className="hidden shrink-0 text-[11px] text-slate-400 md:inline">
                        {fmtCost(cost)}
                      </span>
                    )}
                    <span
                      className={`ml-auto shrink-0 text-[11px] font-semibold uppercase ${
                        state === "done"
                          ? "text-emerald-600"
                          : state === "running" || state === "waiting_gate"
                            ? "text-sky-600"
                            : "text-red-500"
                      }`}
                    >
                      {String(state).replace("_", " ")}
                    </span>
                  </button>

                  {/* per-phase progress: status, and click straight into any
                      phase that has actually run */}
                  {isChain && (
                    <div className="flex flex-wrap items-center gap-1 border-t border-slate-100 px-3 py-1.5">
                      {plan!.map((c, ci) => {
                        const r = c.runId ? byId.get(c.runId) : undefined;
                        const st = r?.status ?? (c.runId ? "running" : "queued");
                        const tone =
                          st === "done"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : st === "running" || st === "waiting_gate"
                              ? "border-sky-300 bg-sky-50 text-sky-700 animate-pulse"
                              : st === "queued"
                                ? "border-dashed border-slate-300 bg-white text-slate-400"
                                : "border-red-200 bg-red-50 text-red-700";
                        return (
                          <span key={ci} className="flex items-center gap-1">
                            {ci > 0 && (
                              <Icon.chevron size={10} strokeWidth={2} className="text-slate-300" />
                            )}
                            <button
                              disabled={!r}
                              onClick={() => r && setRun(r)}
                              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone} ${
                                r ? "hover:brightness-95" : "cursor-default"
                              }`}
                              title={
                                r
                                  ? `${c.title} - ${r.status.replace("_", " ")} (open)`
                                  : `${c.title} - not started yet`
                              }
                            >
                              {ci + 1}. {c.title}
                            </button>
                          </span>
                        );
                      })}
                      {broke && (
                        <span className="ml-auto text-[10px] text-red-600">
                          chain paused - open the failed phase and Resume to continue
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              <span
                className={`inline-flex h-1.5 w-1.5 rounded-full ${
                  label === "Development"
                    ? "bg-indigo-500"
                    : label === "Testing"
                      ? "bg-emerald-500"
                      : label === "Custom"
                        ? "bg-violet-500"
                        : "bg-amber-500"
                }`}
              />
              {label}
            </h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((w) => (
                <div
                  key={w.id}
                  className={`group relative rounded-xl border bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md ${
                    selected?.id === w.id
                      ? "border-slate-900 ring-2 ring-slate-900/10"
                      : "border-slate-200"
                  }`}
                >
                  <button onClick={() => pick(w)} className="w-full p-4 text-left">
                    <div className="flex items-start gap-2.5">
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${wfIdentity(w).tint}`}
                      >
                        {(() => {
                          const I = wfIdentity(w).icon;
                          return <I size={16} strokeWidth={1.75} />;
                        })()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                          {w.title}
                          {w.custom && (
                            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-violet-600">
                              {w.scope === "project" ? "custom · this project" : "custom · all projects"}
                            </span>
                          )}
                          {w.scope === "project" && w.trusted === false && (
                            <span
                              className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-700"
                              title="This workflow ships with the repo and has not been approved on this machine. Review it and save it to approve."
                            >
                              unapproved - review & save to run
                            </span>
                          )}
                          {w.shadowsProject && (
                            <span
                              className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500"
                              title="The repo carries its own workflow with this same id; your copy wins. Rename one of them to use both."
                            >
                              shadows a repo copy
                            </span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">{w.description}</p>
                      </div>
                    </div>
                    {Array.isArray(w.steps) && w.steps.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
                        <span className="rounded-md bg-slate-100 px-1.5 py-px text-[11px] font-semibold text-slate-500">
                          {w.steps.length} steps
                        </span>
                        {(() => {
                          const gates = w.steps!.filter((st) => (st as { type?: string }).type === "gate").length;
                          const agents = w.steps!.filter((st) => (st as { type?: string }).type === "agent").length;
                          return (
                            <>
                              {agents > 0 && (
                                <span className="rounded-md bg-indigo-50 px-1.5 py-px text-[11px] font-semibold text-indigo-600">
                                  {agents} agent
                                </span>
                              )}
                              {gates > 0 && (
                                <span className="rounded-md bg-amber-50 px-1.5 py-px text-[11px] font-semibold text-amber-700">
                                  {<Icon.humanGate size={12} strokeWidth={1.75} className="inline shrink-0 text-amber-500" />} {gates} human gate{gates === 1 ? "" : "s"}
                                </span>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </button>
                  <span className="absolute right-2 top-2 flex gap-0.5">
                    <button
                      onClick={() => {
                        setSeed(w);
                        setDesigning(true);
                      }}
                      className="rounded-md px-1.5 text-xs text-slate-300 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100"
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
                        className="rounded-md px-1.5 text-xs text-slate-300 hover:bg-red-50 hover:text-red-500"
                        title="Delete this custom workflow"
                      >
                <Icon.close size={12} strokeWidth={2.25} />
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
          onClick={(e) => e.target === e.currentTarget && !starting && closeStartForm()}
        >
          <div className="mt-10 w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">{selected.title}</h3>
                <p className="mt-0.5 text-xs text-slate-500">{selected.description}</p>
              </div>
              <button
                onClick={() => !starting && closeStartForm()}
                className="rounded-md px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                title="Close"
              >
                <Icon.close size={12} strokeWidth={2.25} />
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
                <Icon.close size={12} strokeWidth={2.25} />
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
                    {defaultAgent === a.id ? " (default)" : ""}
                    {status?.[a.id]?.installed === false ? " - not installed" : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={() => !starting && closeStartForm()}
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
            {/* a start failure must surface INSIDE the modal: the page-level
                banner paints underneath this dimmed backdrop, so the 403
                "approve this project workflow first" guidance was never read */}
            {error && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">
                {error}
              </div>
            )}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
