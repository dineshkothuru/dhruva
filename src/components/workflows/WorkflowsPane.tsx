"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents";
import { chainState, groupRunsByChain } from "@/lib/chains";
import type { RunState } from "@/lib/workflows/schema";
import { Icon, ROLE_ICON, WF_ICON, wfIconFor, type IconType } from "@/components/icons";
import StepBody, {
  AGENT_OPTIONS,
  CATEGORIES,
  FindingCard,
  fmtCost,
  runCost,
  STATUS_EDGE,
  STATUS_ICON,
  TYPE_CHIP,
} from "@/components/workflows/StepTrace";

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
import { loadRoles, saveRoles, rolesFor, type RoleConfig } from "@/lib/roleStore";
import { STEP_ROLES, ROLE_LABEL, ROLE_TIER } from "@/lib/workflows/schema";
import { loadDefaultAgent, saveDefaultAgent } from "@/lib/agentStore";
import { loadCustomModels, addCustomModel } from "@/lib/modelStore";
import WorkflowBuilder, { type BuilderSeed } from "@/components/workflows/WorkflowBuilder";
import RequirementCards, { parseRequirements } from "@/components/workflows/RequirementCards";
import { parseFindings } from "@/lib/findings";



/** Workflow identity for catalog cards - same house style as the role cards.
 * Icons are components from the shared vocabulary, so they inherit color and
 * stay optically consistent instead of depending on the OS emoji font. */
const WF_META: Record<string, { icon: IconType; tint: string }> = {
  "bug-fix": { icon: WF_ICON.bug, tint: "bg-red-100 text-red-700" },
  "feature-dev": { icon: WF_ICON.feature, tint: "bg-indigo-100 text-indigo-700" },
  "solution-design": { icon: WF_ICON.design, tint: "bg-indigo-100 text-indigo-700" },
  "ux-design": { icon: WF_ICON.ux, tint: "bg-violet-100 text-violet-700" },
  "implement-tdd": { icon: WF_ICON.build, tint: "bg-slate-200 text-slate-700" },
  "test-gen": { icon: WF_ICON.test, tint: "bg-emerald-100 text-emerald-700" },
  "run-tests": { icon: WF_ICON.run, tint: "bg-emerald-100 text-emerald-700" },
  "retrieve-sync": { icon: WF_ICON.sync, tint: "bg-amber-100 text-amber-700" },
  "deploy-preview": { icon: WF_ICON.preview, tint: "bg-amber-100 text-amber-700" },
  "validate-deploy": { icon: WF_ICON.validate, tint: "bg-amber-100 text-amber-700" },
  "scratch-org": { icon: WF_ICON.scratch, tint: "bg-emerald-100 text-emerald-700" },
};

/** Custom workflows auto-pick a fitting identity from their title/description
 * keywords - deterministic, so the same workflow always gets the same face. */
/** One row per EXECUTION, not per step.
 *
 * A step can run several times - an auto-revise replays its target, a gate
 * revision replays it again - and the replay overwrites the step's fields. The
 * finished attempts are kept on `step.attempts`, so the history renders them as
 * their own rows, oldest first, with the current state last. A design reworked
 * three times shows four rows instead of one. */
export type StepRow = RunState["steps"][number] & {
  rowKey: string;
  attemptNo: number;
  attemptsTotal: number;
  supersededBy?: string;
  /** the step's position in the workflow, used only to order rows that have
   * not started and therefore have no timestamp */
  order: number;
};

export function stepRows(run: RunState): StepRow[] {
  const out: StepRow[] = [];
  run.steps.forEach((s, order) => {
    const earlier = s.attempts ?? [];
    const total = earlier.length + 1;
    earlier.forEach((a, n) => {
      out.push({ ...s, ...a, rowKey: `${s.id}#${n}`, attemptNo: n + 1, attemptsTotal: total, order });
    });
    out.push({ ...s, rowKey: s.id, attemptNo: total, attemptsTotal: total, order });
  });
  // CHRONOLOGICAL, not grouped by step. Grouping listed every run of `analyse`
  // and then every run of `design-review`, so a three-round rework read as
  // analyse/analyse/analyse/review/review/review - which is not what happened.
  // The truth interleaves: design, review, redesign, re-review, and so on.
  // Steps that have not started yet keep the workflow's declared order, at the
  // end, because they have no time to sort by.
  return out.sort((a, b) => {
    if (a.startedAt && b.startedAt) return a.startedAt - b.startedAt;
    if (a.startedAt) return -1;
    if (b.startedAt) return 1;
    return a.order - b.order;
  });
}

function wfIdentity(w: { id: string; title: string; description: string }): {
  icon: IconType;
  tint: string;
} {
  const known = WF_META[w.id];
  if (known) return known;
  const icon = wfIconFor(w.id, `${w.title} ${w.description}`);
  const TINT = new Map<IconType, string>([
    [WF_ICON.bug, "bg-red-100 text-red-700"],
    [WF_ICON.deploy, "bg-amber-100 text-amber-700"],
    [WF_ICON.test, "bg-emerald-100 text-emerald-700"],
    [WF_ICON.review, "bg-amber-100 text-amber-700"],
    [WF_ICON.ux, "bg-violet-100 text-violet-700"],
    [WF_ICON.design, "bg-indigo-100 text-indigo-700"],
    [WF_ICON.doc, "bg-sky-100 text-sky-700"],
    [WF_ICON.build, "bg-slate-200 text-slate-700"],
    [WF_ICON.sync, "bg-amber-100 text-amber-700"],
    [WF_ICON.scratch, "bg-emerald-100 text-emerald-700"],
  ]);
  return { icon, tint: TINT.get(icon) ?? "bg-violet-100 text-violet-700" };
}

/** Visual identity per role - icon tile tint, what it means, which steps use it. */
const ROLE_META: Record<string, { icon: IconType; tint: string; blurb: string; steps: string[] }> = {
  read: { icon: ROLE_ICON.read, tint: "bg-sky-100 text-sky-700", blurb: "investigates code and documents before anything changes", steps: ["locate", "plan", "assess"] },
  design: { icon: ROLE_ICON.design, tint: "bg-indigo-100 text-indigo-700", blurb: "authors designs, specs, and documents", steps: ["analyse", "spec", "write-doc"] },
  implement: { icon: ROLE_ICON.implement, tint: "bg-slate-200 text-slate-700", blurb: "writes the code and tests", steps: ["implement"] },
  review: { icon: ROLE_ICON.review, tint: "bg-amber-100 text-amber-700", blurb: "adversarially critiques designs and diffs", steps: ["design-review", "review"] },
  trace: { icon: ROLE_ICON.trace, tint: "bg-emerald-100 text-emerald-700", blurb: "verifies every requirement is covered", steps: ["coverage-check", "traceability"] },
};



/** A destructive action that asks first, in the page.
 *
 * These buttons used to guard themselves with `window.confirm`. In an embedded
 * webview - the app shell, and the preview pane this is tested in - native
 * dialogs are suppressed: `confirm()` returns false immediately without ever
 * showing anything, so "Stop run" silently did nothing while the run kept
 * going. Two clicks in the page work everywhere, and the armed state says what
 * the second click will do. */
function ConfirmButton({
  label,
  armed,
  title,
  className,
  onConfirm,
  disabled,
}: {
  label: string;
  /** what the button says once it is waiting for the second click */
  armed: string;
  title: string;
  className: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    // disarm on its own, so a button left armed cannot be triggered later by
    // a click the user has forgotten the meaning of
    const t = setTimeout(() => setPending(false), 6000);
    return () => clearTimeout(t);
  }, [pending]);
  return (
    <button
      onClick={async () => {
        if (!pending) {
          setPending(true);
          return;
        }
        setPending(false);
        await onConfirm();
      }}
      disabled={disabled}
      title={title}
      className={
        pending
          ? "rounded-lg border border-red-400 bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-700"
          : className
      }
    >
      {pending ? armed : label}
    </button>
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
  // results that used to go to window.alert, which the app shell suppresses
  const [notice, setNotice] = useState<string | null>(null);
  const [gateNote, setGateNote] = useState("");
  const [gating, setGating] = useState(false);
  // Documents a step wrote, by project-relative path. The gate renders its
  // cards from the DESIGN, not from the step's output: once the designer sends
  // a delta, that output is only the blocks it changed, and cards built from
  // it would show three requirements and imply the other thirty-one had gone.
  const [docs, setDocs] = useState<Record<string, string>>({});
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

  async function gate(decision: "approve" | "abort" | "revise" | "park", feedback?: string) {
    if (!run || gating) return;
    setGating(true);
    try {
      const { ok, data } = await api({ action: "gate", runId: run.runId, decision, feedback });
      if (ok && data.resolved === false) {
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
                        Diagnosis ({agent})
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
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
