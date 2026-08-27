"use client";

/** Interactive chain proposal - rendered in chat when the intake detects a
 * multi-phase request ("design and implement"). The user reshapes the chain
 * (any standard or custom workflow per phase, add/remove phases) and starts
 * it with one click. Purely deterministic: no tokens spent until Run. */

export interface WfLite {
  id: string;
  title: string;
  description?: string;
  custom?: boolean;
  steps?: { type?: string }[];
  inputs: {
    key: string;
    kind: "text" | "boolean" | "select";
    default?: string | boolean;
    attachTo?: boolean;
    hidden?: boolean;
  }[];
}

export interface ChainSlot {
  workflow: string;
  title: string;
}

export function chainIcon(id: string, title: string): string {
  const s = `${id} ${title}`.toLowerCase();
  if (/design|architect|erd|hld|blueprint/.test(s)) return "📐";
  if (/ux|ui\b|screen|visual/.test(s)) return "🎨";
  if (/implement|tdd|build|develop/.test(s)) return "🛠️";
  if (/test|qa\b/.test(s)) return "🧪";
  if (/bug|fix|hotfix/.test(s)) return "🩹";
  if (/deploy|release|ship/.test(s)) return "🚀";
  if (/review|audit/.test(s)) return "🔍";
  if (/doc\b|docs|document/.test(s)) return "📄";
  return "⚙️";
}

export default function ChainProposalCard({
  slots,
  reason,
  resolved,
  catalog,
  starting,
  auto,
  onAuto,
  onChange,
  onRun,
  onJustAsk,
}: {
  slots: ChainSlot[];
  reason: string;
  resolved?: string;
  catalog: WfLite[] | null;
  starting: boolean;
  /** unattended mode: an AI gatekeeper clears the human gates (audited). */
  auto: boolean;
  onAuto: (v: boolean) => void;
  onChange: (slots: ChainSlot[]) => void;
  onRun: () => void;
  onJustAsk: () => void;
}) {
  const standard = (catalog ?? []).filter((w) => !w.custom);
  const custom = (catalog ?? []).filter((w) => w.custom);
  const defFor = (id: string) => catalog?.find((w) => w.id === id);

  function setSlot(i: number, workflowId: string) {
    const def = defFor(workflowId);
    onChange(slots.map((s, k) => (k === i ? { workflow: workflowId, title: def?.title ?? workflowId } : s)));
  }
  function removeSlot(i: number) {
    if (slots.length <= 1) return;
    onChange(slots.filter((_, k) => k !== i));
  }
  function addSlot() {
    if (slots.length >= 5) return;
    const first = standard[0] ?? custom[0];
    if (!first) return;
    onChange([...slots, { workflow: first.id, title: first.title }]);
  }

  const designToImplement = slots.some(
    (s, i) => s.workflow === "solution-design" && slots[i + 1]?.workflow === "implement-tdd",
  );

  return (
    <div className="rounded-xl bg-gradient-to-r from-indigo-300 via-sky-300 to-emerald-300 p-[1.5px] shadow-sm">
      <div className="rounded-[14px] bg-white px-4 py-3.5">
        {/* header */}
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-base">
            ⛓️
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800">Delivery chain proposed</p>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{reason}. Adjust the phases, then run - each phase keeps its human gates.</p>
          </div>
        </div>

        {/* the chain rail */}
        <div className="mt-3 flex items-stretch overflow-x-auto pb-1">
          {slots.map((s, i) => {
            const def = defFor(s.workflow);
            const steps = def?.steps ?? [];
            const gates = steps.filter((x) => x.type === "gate").length;
            return (
              <div key={i} className="flex shrink-0 items-center">
                {i > 0 && (
                  <div className="flex flex-col items-center justify-center px-1.5" title="starts automatically after the previous phase finishes clean">
                    <svg width="30" height="10" viewBox="0 0 30 10" className="text-indigo-300">
                      <line x1="0" y1="5" x2="22" y2="5" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />
                      <path d="M21 1 L29 5 L21 9 Z" fill="currentColor" />
                    </svg>
                    <span className="mt-1 animate-pulse rounded-full bg-indigo-100 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-indigo-500">
                      auto
                    </span>
                  </div>
                )}
                <div className="relative w-52 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  {slots.length > 1 && !resolved && (
                    <button
                      onClick={() => removeSlot(i)}
                      className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-md text-[11px] text-slate-300 hover:bg-red-50 hover:text-red-500"
                      title="Remove this phase"
                    >
                      ✕
                    </button>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-base shadow-sm">
                      {chainIcon(s.workflow, s.title)}
                    </span>
                    <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
                      Phase {i + 1}
                    </span>
                  </div>
                  {resolved ? (
                    <p className="mt-2 truncate text-xs font-semibold text-slate-700">{s.title}</p>
                  ) : (
                    <select
                      value={s.workflow}
                      onChange={(e) => setSlot(i, e.target.value)}
                      className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 outline-none focus:border-indigo-400"
                      title="Any workflow can fill this phase - standard or your custom ones"
                    >
                      {!catalog && <option value={s.workflow}>{s.title}</option>}
                      {standard.length > 0 && (
                        <optgroup label="Standard workflows">
                          {standard.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.title}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {custom.length > 0 && (
                        <optgroup label="Your custom workflows">
                          {custom.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.title}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  )}
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    {def ? (
                      <>
                        {steps.length} steps
                        {gates > 0 && <> · {gates} 🙋 {gates === 1 ? "gate" : "gates"}</>}
                      </>
                    ) : (
                      "…"
                    )}
                  </p>
                </div>
              </div>
            );
          })}
          {!resolved && slots.length < 5 && (
            <button
              onClick={addSlot}
              className="ml-2 flex w-16 shrink-0 flex-col items-center justify-center gap-1 self-stretch rounded-xl border border-dashed border-slate-300 text-slate-400 hover:border-indigo-300 hover:text-indigo-500"
              title="Add another phase to the chain"
            >
              <span className="text-lg leading-none">+</span>
              <span className="text-[11px] font-medium uppercase tracking-wide">phase</span>
            </button>
          )}
        </div>

        {designToImplement && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
            <span>📄</span> The TDD and build plan written by Solution design are wired into Implement from TDD automatically.
          </p>
        )}

        {/* footer */}
        {resolved ? (
          <p className="mt-3 border-t border-slate-100 pt-2.5 text-xs text-indigo-600">→ {resolved}</p>
        ) : (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <label
              className={`flex w-fit cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${
                auto
                  ? "border-violet-300 bg-violet-50 text-violet-700"
                  : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
              }`}
              title="An AI gatekeeper (review role) clears each human gate: it approves, sends bounded revisions, or hands the gate back to you when unsure. Every decision and its reasoning is written into the gate's audit log."
            >
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => onAuto(e.target.checked)}
                className="h-3.5 w-3.5 accent-violet-600"
              />
              <span>
                🤖 <span className="font-semibold">Unattended</span> - an AI gatekeeper clears the
                human gates (audited; escalates to you when unsure)
              </span>
            </label>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                onClick={onRun}
                disabled={starting || slots.length === 0}
                className="rounded-lg bg-gradient-to-r from-indigo-600 to-sky-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:from-indigo-500 hover:to-sky-500 disabled:opacity-50"
              >
                ▶ Run chain · {slots.length} {slots.length === 1 ? "workflow" : "workflows"}
              </button>
              <button
                onClick={onJustAsk}
                disabled={starting}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Just ask the agent
              </button>
              <span className="ml-auto text-[11px] text-slate-400">
                {auto
                  ? "every gatekeeper decision is written into the run audit"
                  : "the next phase starts only after a clean finish"}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
