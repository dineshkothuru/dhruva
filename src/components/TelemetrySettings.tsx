"use client";

import { useEffect, useState } from "react";

/** The permanent home of the telemetry choice - Setup tab. Shows the exact
 * contract (what is sent, what never is) next to the switch, so the setting
 * is auditable without reading the source. */

interface State {
  configured: boolean;
  asked: boolean;
  enabled: boolean;
  envDisabled: boolean;
}

export default function TelemetrySettings({ active }: { active: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "state" }),
    });
    setState(await r.json());
  }

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "state" }),
        });
        if (!cancelled) setState(await r.json());
      } catch {
        /* leave it unrendered */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await fetch("/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", enabled }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

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
            Applies to this machine, not just this project.
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
        ) : state.envDisabled ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
            Disabled by the environment (<span className="font-mono">DHRUVA_TELEMETRY=0</span> or{" "}
            <span className="font-mono">DO_NOT_TRACK=1</span>). Nothing is sent regardless of the
            setting below.
          </p>
        ) : (
          <>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={state.enabled}
                disabled={busy}
                onChange={(e) => void toggle(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-slate-900"
              />
              <span className="text-xs text-slate-700">
                Share anonymous usage statistics
              </span>
            </label>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 px-2.5 py-2">
                <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-700">
                  Sent
                </p>
                <ul className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-emerald-900/80">
                  <li>app version, OS</li>
                  <li>which shipped workflow ran</li>
                  <li>agent and model tier</li>
                  <li>finished / failed / aborted</li>
                  <li>duration as a range</li>
                </ul>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                  Never sent
                </p>
                <ul className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-slate-600">
                  <li>code, diffs, file paths</li>
                  <li>project, folder or org names</li>
                  <li>prompts and agent output</li>
                  <li>custom workflow names</li>
                  <li>anything about your customers</li>
                </ul>
              </div>
            </div>

            <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
              Identified only by a random id generated on this machine. Set{" "}
              <span className="font-mono">DHRUVA_TELEMETRY=0</span> to force it off everywhere.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
