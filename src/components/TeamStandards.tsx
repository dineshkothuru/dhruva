"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

/** Read-only browser of the SHIPPED standards library - the rules and
 * personas the engine injects into every agent prompt. It sits beside
 * Project skills so an author can see what is ALREADY covered instead of
 * duplicating it into a skill. Nothing here is editable per project. */

interface Lib {
  baseline: { body: string };
  modules: { name: string; body: string }[];
  personas: { name: string; body: string }[];
}

/** Standards are grouped by the area they govern so the list is scannable
 * rather than an undifferentiated cloud of 20 chips. The mapping is by name,
 * with anything unmatched falling into "General". */
const GROUPS: [string, RegExp][] = [
  ["Apex", /^apex|^salesforce-(logging|hard-guardrails)/],
  ["UI", /^lwc|aura|^salesforce-design/],
  ["Automation", /flow/],
  ["Data & security", /security|permission|schema|metadata/],
  ["Process", /^baseline|^global|^pr-|agent-safety/],
];

function groupOf(name: string): string {
  for (const [label, re] of GROUPS) if (re.test(name)) return label;
  return "General";
}

export default function TeamStandards({ active }: { active: boolean }) {
  const [lib, setLib] = useState<Lib | null>(null);
  const [viewing, setViewing] = useState<{ title: string; body: string } | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!active || lib) return;
    let cancelled = false;
    fetch("/api/standards")
      .then((r) => r.json())
      .then((d: Lib) => {
        if (!cancelled) setLib(d);
      })
      .catch(() => {
        /* the browser just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [active, lib]);

  const match = (t: string) => t.toLowerCase().includes(q.trim().toLowerCase());
  const allRules = lib
    ? [{ title: "baseline", body: lib.baseline.body }, ...lib.modules.map((m) => ({ title: m.name, body: m.body }))]
    : [];
  const groups: [string, { title: string; body: string }[]][] = [
    ...GROUPS.map(([label]) => label),
    "General",
  ].map((label) => [label, allRules.filter((r) => groupOf(r.title) === label && match(r.title))]);
  const personas = (lib?.personas ?? [])
    .map((p) => ({ title: p.name, body: p.body }))
    .filter((p) => match(p.title));
  const ruleCount = allRules.length;

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <header className="flex items-start gap-2.5 border-b border-slate-100 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
          <Icon.standards size={15} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-slate-800">Team standards</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            {ruleCount > 0 ? `${ruleCount} rules and ${lib?.personas.length ?? 0} personas ` : ""}
            injected into every agent prompt. Same for every project.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          read-only
        </span>
      </header>

      <div className="px-4 py-3">
        {!lib ? (
          <div className="flex items-center gap-2 py-2">
            <Icon.running size={13} strokeWidth={1.75} className="animate-pulse text-slate-300" />
            <p className="text-[11px] text-slate-400">Loading the library…</p>
          </div>
        ) : (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter rules and personas…"
              className="mb-3 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] outline-none placeholder:text-slate-400 focus:border-slate-400"
            />

            {groups.map(([label, items]) =>
              items.length === 0 ? null : (
                <div key={label} className="mb-3 last:mb-0">
                  <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    {label}
                    <span className="ml-1.5 font-medium normal-case tracking-normal text-slate-300">
                      {items.length}
                    </span>
                  </p>
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {items.map((x) => (
                      <button
                        key={x.title}
                        onClick={() => setViewing(x)}
                        className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                        title="View (read-only)"
                      >
                        <Icon.standards
                          size={12}
                          strokeWidth={1.75}
                          className="shrink-0 text-slate-300 group-hover:text-indigo-500"
                        />
                        <span className="truncate">{x.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ),
            )}

            <div className="mt-3.5 border-t border-slate-100 pt-2.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                <Icon.persona size={11} strokeWidth={1.75} />
                Personas
                <span className="font-medium normal-case tracking-normal text-slate-300">
                  the hat each agent step wears
                </span>
              </p>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {personas.map((p) => (
                  <button
                    key={p.title}
                    onClick={() => setViewing(p)}
                    className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                    title="View (read-only)"
                  >
                    <Icon.persona
                      size={12}
                      strokeWidth={1.75}
                      className="shrink-0 text-slate-300 group-hover:text-violet-500"
                    />
                    <span className="truncate">{p.title}</span>
                  </button>
                ))}
              </div>
            </div>

            {q && groups.every(([, i]) => i.length === 0) && personas.length === 0 && (
              <p className="py-2 text-[11px] text-slate-400">Nothing matches “{q}”.</p>
            )}
          </>
        )}
      </div>

      {viewing && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-8"
          onClick={(e) => e.target === e.currentTarget && setViewing(null)}
        >
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center">
              <h3 className="text-sm font-semibold">{viewing.title}</h3>
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-400">
                read-only · shipped standard
              </span>
              <button
                onClick={() => setViewing(null)}
                className="ml-auto rounded-md px-2 text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
            <pre className="mt-3 max-h-[70vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
              {viewing.body}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
