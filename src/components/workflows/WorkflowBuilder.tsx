"use client";

import { useState } from "react";

/** UI designer for custom workflows — builds the same WorkflowDef shape as
 * built-ins; the engine runs them identically. Saved per project into
 * .sfharness/workflows/<id>.json via the workflow API. */

interface StepDraft {
  id: string;
  title: string;
  type: "snapshot" | "agent" | "cli" | "gate" | "changes" | "verify" | "tasks-check";
  prompt?: string;
  readOnly?: boolean;
  role?: "" | "read" | "design" | "implement" | "review" | "trace";
  bin?: "sf" | "git";
  argsText?: string; // one arg per line
  message?: string;
  reviseTarget?: string;
  onlyIf?: string;
  /** Fields this simple builder doesn't edit (persona, autoRevise, tasksFile,
   * timeouts…) — carried through untouched so duplicating a built-in loses
   * NOTHING. Spread first on save; edited fields override. */
  extra?: Record<string, unknown>;
}

interface InputDraft {
  key: string;
  label: string;
  kind: "text" | "boolean";
  extra?: Record<string, unknown>; // select options, defaults, attachTo — passthrough
}

/** Any workflow definition (built-in or custom) prefills the builder for
 * duplicate-and-customize. */
export interface BuilderSeed {
  id: string;
  title: string;
  description: string;
  inputs: Record<string, unknown>[];
  steps: Record<string, unknown>[];
}

const DRAFT_STEP_KEYS = new Set([
  "id", "title", "type", "prompt", "readOnly", "role", "bin", "args", "message", "reviseTarget", "onlyIf",
]);
const DRAFT_INPUT_KEYS = new Set(["key", "label", "kind"]);

function seedToDrafts(seed: BuilderSeed): { inputs: InputDraft[]; steps: StepDraft[] } {
  return {
    inputs: seed.inputs.map((i) => ({
      key: String(i.key ?? ""),
      label: String(i.label ?? i.key ?? ""),
      kind: i.kind === "boolean" ? "boolean" : "text",
      extra: Object.fromEntries(Object.entries(i).filter(([k]) => !DRAFT_INPUT_KEYS.has(k))),
    })),
    steps: seed.steps.map((s) => ({
      id: String(s.id ?? ""),
      title: String(s.title ?? s.id ?? ""),
      type: (s.type as StepDraft["type"]) ?? "agent",
      prompt: typeof s.prompt === "string" ? s.prompt : undefined,
      readOnly: s.readOnly === true || undefined,
      role: (s.role as StepDraft["role"]) ?? "",
      bin: (s.bin as StepDraft["bin"]) ?? undefined,
      argsText: Array.isArray(s.args) ? (s.args as string[]).join("\n") : undefined,
      message: typeof s.message === "string" ? s.message : undefined,
      reviseTarget: typeof s.reviseTarget === "string" ? s.reviseTarget : undefined,
      onlyIf: typeof s.onlyIf === "string" ? s.onlyIf : undefined,
      extra: Object.fromEntries(Object.entries(s).filter(([k]) => !DRAFT_STEP_KEYS.has(k))),
    })),
  };
}

const STEP_HINTS: Record<StepDraft["type"], string> = {
  snapshot: "Deterministic: records the folder state so later diffs are exact.",
  agent: "AI step. Placeholders: {inputs.<key>}, {steps.<id>.output}.",
  cli: "Deterministic: sf/git command. One argument per line. Placeholders allowed; {changedSourceDirs} expands to the changed files.",
  gate: "Pauses for human Approve / Revise / Abort.",
  changes: "Deterministic: collects files changed since the last snapshot.",
  verify: "Deterministic: standards checks over the changed files.",
  "tasks-check": "Deterministic: validates the build-plan tasks file (ids, dependencies, no cycles).",
};

export default function WorkflowBuilder({
  root,
  seed,
  onSaved,
  onCancel,
}: {
  root: string;
  /** Duplicate-to-customize: prefill from an existing workflow. */
  seed?: BuilderSeed | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const seeded = seed ? seedToDrafts(seed) : null;
  const [id, setId] = useState(seed ? `${seed.id}-copy` : "");
  const [title, setTitle] = useState(seed ? `${seed.title} (copy)` : "");
  const [description, setDescription] = useState(seed?.description ?? "");
  const [inputs, setInputs] = useState<InputDraft[]>(seeded?.inputs ?? []);
  const [steps, setSteps] = useState<StepDraft[]>(
    seeded?.steps ?? [{ id: "snapshot", title: "Snapshot baseline", type: "snapshot" }],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function updStep(i: number, patch: Partial<StepDraft>) {
    setSteps((s) => s.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  }
  function move(i: number, dir: -1 | 1) {
    setSteps((s) => {
      const n = [...s];
      const j = i + dir;
      if (j < 0 || j >= n.length) return s;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const def = {
        id: id.trim(),
        title: title.trim(),
        description: description.trim(),
        inputs: inputs.map((i) => ({
          ...i.extra,
          key: i.key.trim(),
          label: i.label.trim() || i.key,
          kind: i.kind,
        })),
        steps: steps.map((s) => ({
          ...s.extra, // passthrough: persona, autoRevise, tasksFile, timeouts…
          id: s.id.trim(),
          title: s.title.trim() || s.id,
          type: s.type,
          ...(s.type === "agent"
            ? {
                prompt: s.prompt ?? "",
                readOnly: s.readOnly || undefined,
                role: s.role || undefined,
              }
            : {}),
          ...(s.type === "cli"
            ? {
                bin: s.bin ?? "sf",
                args: (s.argsText ?? "").split("\n").map((a) => a.trim()).filter(Boolean),
              }
            : {}),
          ...(s.type === "gate"
            ? { message: s.message ?? "Proceed?", reviseTarget: s.reviseTarget?.trim() || undefined }
            : {}),
          onlyIf: s.onlyIf?.trim() || undefined,
        })),
      };
      const res = await fetch("/api/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // saved centrally (~/.dhruva/workflows) — available in every project
        // the user connects on this machine. (.sfharness/workflows is still
        // READ as an escape hatch for manually distributed files, but the UI
        // never writes there: the harness git-excludes .sfharness, so a
        // project-scoped copy could never actually travel with the repo.)
        body: JSON.stringify({ action: "save-custom", root, def, scope: "central" }),
      });
      const data = await res.json();
      if (!res.ok) setError(String(data.error ?? "could not save"));
      else onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    "rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-slate-500";

  return (
    <div className="mt-5 rounded-xl border border-slate-300 bg-white p-4">
      <h3 className="text-sm font-semibold">Design a workflow</h3>
      <p className="mt-0.5 text-[11px] text-slate-400">
        Saved into this project (.sfharness/workflows) and run by the same engine as built-ins —
        gates, standards, role-based models, audit included.
      </p>
      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="id (slug, e.g. my-check)" spellCheck={false} className={`${inputCls} w-44 font-mono`} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={`${inputCls} w-56`} />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className={`${inputCls} flex-1 min-w-[200px]`} />
      </div>

      {/* inputs */}
      <div className="mt-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Inputs</span>
          <button
            onClick={() => setInputs((v) => [...v, { key: `input${v.length + 1}`, label: "", kind: "text" }])}
            className="rounded border border-slate-300 px-2 py-0.5 text-[11px] hover:bg-slate-50"
          >
            + add input
          </button>
        </div>
        {inputs.map((inp, i) => (
          <div key={i} className="mt-1.5 flex flex-wrap items-center gap-2">
            <input value={inp.key} onChange={(e) => setInputs((v) => v.map((x, n) => (n === i ? { ...x, key: e.target.value } : x)))} placeholder="key" spellCheck={false} className={`${inputCls} w-36 font-mono`} />
            <input value={inp.label} onChange={(e) => setInputs((v) => v.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)))} placeholder="Label shown to the user" className={`${inputCls} w-72`} />
            <select value={inp.kind} onChange={(e) => setInputs((v) => v.map((x, n) => (n === i ? { ...x, kind: e.target.value as InputDraft["kind"] } : x)))} className={inputCls}>
              <option value="text">text</option>
              <option value="boolean">boolean</option>
            </select>
            <button onClick={() => setInputs((v) => v.filter((_, n) => n !== i))} className="text-slate-400 hover:text-red-500">✕</button>
          </div>
        ))}
      </div>

      {/* steps */}
      <div className="mt-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Steps (run top to bottom)</span>
          <button
            onClick={() => setSteps((v) => [...v, { id: `step-${v.length + 1}`, title: "", type: "agent" }])}
            className="rounded border border-slate-300 px-2 py-0.5 text-[11px] hover:bg-slate-50"
          >
            + add step
          </button>
        </div>
        <div className="mt-2 space-y-2">
          {steps.map((s, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-slate-400">{i + 1}.</span>
                <input value={s.id} onChange={(e) => updStep(i, { id: e.target.value })} placeholder="step-id" spellCheck={false} className={`${inputCls} w-32 font-mono`} />
                <input value={s.title} onChange={(e) => updStep(i, { title: e.target.value })} placeholder="Step title" className={`${inputCls} w-64`} />
                <select value={s.type} onChange={(e) => updStep(i, { type: e.target.value as StepDraft["type"] })} className={inputCls}>
                  {Object.keys(STEP_HINTS).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <input value={s.onlyIf ?? ""} onChange={(e) => updStep(i, { onlyIf: e.target.value })} placeholder="onlyIf input-key" spellCheck={false} className={`${inputCls} w-36 font-mono`} title="Skip this step unless this boolean input is checked" />
                <span className="ml-auto flex gap-1">
                  <button onClick={() => move(i, -1)} className="rounded border border-slate-200 px-1.5 text-[11px] hover:bg-slate-50">↑</button>
                  <button onClick={() => move(i, 1)} className="rounded border border-slate-200 px-1.5 text-[11px] hover:bg-slate-50">↓</button>
                  <button onClick={() => setSteps((v) => v.filter((_, n) => n !== i))} className="rounded border border-slate-200 px-1.5 text-[11px] text-red-500 hover:bg-red-50">✕</button>
                </span>
              </div>
              <p className="mt-1 text-[10px] text-slate-400">{STEP_HINTS[s.type]}</p>
              {s.type === "agent" && (
                <div className="mt-2 space-y-2">
                  <textarea value={s.prompt ?? ""} onChange={(e) => updStep(i, { prompt: e.target.value })} rows={3} placeholder="Prompt for the agent… use {inputs.key} and {steps.step-id.output}" className={`${inputCls} w-full`} />
                  <div className="flex items-center gap-4 text-[11px] text-slate-500">
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={s.readOnly ?? false} onChange={(e) => updStep(i, { readOnly: e.target.checked })} />
                      read-only (analysis/review)
                    </label>
                    <label className="flex items-center gap-1">
                      role
                      <select value={s.role ?? ""} onChange={(e) => updStep(i, { role: e.target.value as StepDraft["role"] })} className={inputCls} title="Which model plays this step — resolved from your Models-by-role settings">
                        <option value="">run default</option>
                        <option value="read">read / investigate</option>
                        <option value="design">design / author</option>
                        <option value="implement">implement</option>
                        <option value="review">review (critic)</option>
                        <option value="trace">trace / coverage</option>
                      </select>
                    </label>
                  </div>
                </div>
              )}
              {s.type === "cli" && (
                <div className="mt-2 flex gap-2">
                  <select value={s.bin ?? "sf"} onChange={(e) => updStep(i, { bin: e.target.value as "sf" | "git" })} className={inputCls}>
                    <option value="sf">sf</option>
                    <option value="git">git</option>
                  </select>
                  <textarea value={s.argsText ?? ""} onChange={(e) => updStep(i, { argsText: e.target.value })} rows={3} placeholder={"one argument per line, e.g.\nproject\ndeploy\npreview\n--json"} spellCheck={false} className={`${inputCls} flex-1 font-mono`} />
                </div>
              )}
              {s.type === "gate" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input value={s.message ?? ""} onChange={(e) => updStep(i, { message: e.target.value })} placeholder="Message shown to the approver" className={`${inputCls} flex-1 min-w-[240px]`} />
                  <input value={s.reviseTarget ?? ""} onChange={(e) => updStep(i, { reviseTarget: e.target.value })} placeholder="reviseTarget step-id" spellCheck={false} className={`${inputCls} w-44 font-mono`} title="Which agent step a Revise decision re-runs" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="mt-4 text-[11px] text-slate-400">
        Saved to your machine&apos;s workflow library (~/.config/dhruva/workflows) — available in
        every project you connect.
      </p>
      <div className="mt-3 flex gap-2">
        <button onClick={save} disabled={saving || !id.trim() || !title.trim() || steps.length === 0} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40">
          {saving ? "Saving…" : "Save workflow"}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50">
          Cancel
        </button>
      </div>
    </div>
  );
}
