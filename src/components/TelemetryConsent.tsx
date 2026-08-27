"use client";

import { useEffect, useState } from "react";

/** One-time opt-in. Telemetry stays OFF unless the user says yes here (or in
 * Setup), because Dhruva runs inside customer codebases. The prompt states
 * exactly what would be sent and what never is - no dark patterns, and
 * "No thanks" is a normal-weight button, not a hidden link. */

interface State {
  configured: boolean;
  asked: boolean;
  enabled: boolean;
  envDisabled: boolean;
}

export default function TelemetryConsent() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
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
  }, []);

  async function choose(enabled: boolean) {
    setBusy(true);
    try {
      const r = await fetch("/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", enabled }),
      });
      setState(await r.json());
    } finally {
      setBusy(false);
    }
  }

  // nothing to ask when there is no backend, the env disabled it, or the
  // user already answered once
  if (!state || !state.configured || state.envDisabled || state.asked) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
      <div className="flex items-start gap-2">
        <span className="text-base">📊</span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-800">Help improve Dhruva?</p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            Anonymous usage stats: which workflows run, which agent and model tier, whether a run
            finished or failed.
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            <span className="font-semibold text-slate-700">Never sent:</span> your code, file
            paths, project or org names, prompts, agent output, or anything about your customers.
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => choose(true)}
          disabled={busy}
          className="flex-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          Sure, share
        </button>
        <button
          onClick={() => choose(false)}
          disabled={busy}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          No thanks
        </button>
      </div>
      <p className="mt-2 text-[10px] text-slate-400">Change it any time in Setup.</p>
    </div>
  );
}
