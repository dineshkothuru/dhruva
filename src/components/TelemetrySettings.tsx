"use client";

import { useEffect, useState } from "react";

/** Read-only transparency card. Analytics are always on when a backend is
 * configured - there is deliberately no switch here. What this card owes the
 * user is not control but disclosure: the exact contents of what leaves the
 * machine, and the explicit statement of what never does. */

interface State {
  configured: boolean;
  enabled: boolean;
  envDisabled: boolean;
}

export default function TelemetrySettings({ active }: { active: boolean }) {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "state" }),
    })
      .then((r) => r.json())
      .then((s: State) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active]);

  if (!state) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <header className="flex items-start gap-2.5 border-b border-slate-100 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-base">
          📊
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-slate-800">Usage analytics</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            Anonymous product statistics that help improve Dhruva.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
            state.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          {state.enabled ? "on" : "off"}
        </span>
      </header>

      <div className="px-4 py-3">
        {!state.configured ? (
          <p className="text-[11px] leading-relaxed text-slate-500">
            No analytics backend is configured in this build, so nothing is collected or sent.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 px-2.5 py-2">
                <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-700">
                  Collected
                </p>
                <ul className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-emerald-900/80">
                  <li>app version, operating system</li>
                  <li>which shipped workflow ran</li>
                  <li>agent and model tier</li>
                  <li>finished / failed / aborted</li>
                  <li>duration as a range</li>
                </ul>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                  Never collected
                </p>
                <ul className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-slate-600">
                  <li>code, diffs, file paths</li>
                  <li>project, folder or org names</li>
                  <li>prompts and agent output</li>
                  <li>custom workflow names</li>
                  <li>your IP address or location</li>
                </ul>
              </div>
            </div>

            <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
              Your install is a random id generated on this machine. It identifies no person and no
              organisation, and the IP address is discarded on arrival.
            </p>

            {state.envDisabled && (
              <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                Currently disabled by this machine&apos;s environment configuration.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
