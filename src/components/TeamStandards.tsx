"use client";

import { useEffect, useState } from "react";

/** Read-only browser of the SHIPPED standards library - the rules and
 * personas the engine injects into every agent prompt. It sits beside
 * Project skills so an author can see what is ALREADY covered instead of
 * duplicating it into a skill. Nothing here is editable per project. */

interface Lib {
  baseline: { body: string };
  modules: { name: string; body: string }[];
  personas: { name: string; body: string }[];
}

function Chip({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700"
      title="view (read-only)"
    >
      <span className="text-[9px] opacity-60 group-hover:opacity-100">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

export default function TeamStandards({ active }: { active: boolean }) {
  const [lib, setLib] = useState<Lib | null>(null);
  const [viewing, setViewing] = useState<{ title: string; body: string } | null>(null);

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

  const ruleCount = lib ? lib.modules.length + 1 : 0;

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <header className="flex items-start gap-2.5 border-b border-slate-100 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-base">
          📚
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-slate-800">Team standards</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            Shipped with Dhruva and injected into every agent prompt. Same for every project.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
          read-only
        </span>
      </header>

      <div className="px-4 py-3">
        {!lib ? (
          <p className="text-[11px] text-slate-400">loading…</p>
        ) : (
          <>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                Rules
              </span>
              <span className="rounded bg-slate-100 px-1.5 text-[9px] font-semibold text-slate-500">
                {ruleCount}
              </span>
              <span className="text-[10px] text-slate-400">scoped to matching files</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {[
                { title: "baseline", body: lib.baseline.body },
                ...lib.modules.map((m) => ({ title: m.name, body: m.body })),
              ].map((x) => (
                <Chip
                  key={x.title}
                  icon="📕"
                  label={x.title}
                  onClick={() => setViewing({ title: x.title, body: x.body })}
                />
              ))}
            </div>

            <div className="mt-3.5 flex items-baseline gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                Personas
              </span>
              <span className="rounded bg-slate-100 px-1.5 text-[9px] font-semibold text-slate-500">
                {lib.personas.length}
              </span>
              <span className="text-[10px] text-slate-400">the hat each agent step wears</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {lib.personas.map((p) => (
                <Chip
                  key={p.name}
                  icon="🎭"
                  label={p.name}
                  onClick={() => setViewing({ title: `${p.name} (persona)`, body: p.body })}
                />
              ))}
            </div>
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
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-400">
                read-only · shipped standard
              </span>
              <button
                onClick={() => setViewing(null)}
                className="ml-auto rounded px-2 text-slate-400 hover:text-slate-700"
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
