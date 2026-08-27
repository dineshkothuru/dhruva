"use client";

import { useEffect, useRef, useState } from "react";

/** Local Dev preview control - replaces the raw console: pick the app/site
 * in a modal, the dev server runs hidden, status + logs stream here, Stop
 * kills it. The CLI itself opens the org in the browser when ready. */

async function api(body: Record<string, unknown>) {
  const res = await fetch("/api/preview-org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { ok: res.ok, data: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, data: { error: `HTTP ${res.status}` } };
  }
}

export default function PreviewPanel({ root }: { root: string }) {
  const [choices, setChoices] = useState<{
    kind: "app" | "site";
    items: { name: string; label: string; lwr?: boolean | null }[];
  } | null>(null);
  const [loadingChoices, setLoadingChoices] = useState<"app" | "site" | null>(null);
  const [status, setStatus] = useState<{
    running: boolean;
    kind?: string;
    name?: string;
    logs?: string;
    prompt?: string | null;
  }>({ running: false });
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // poll status while a preview runs
  useEffect(() => {
    const tick = async () => {
      const { ok, data } = await api({ path: root, action: "status" });
      if (ok) setStatus(data);
    };
    void tick();
    pollRef.current = setInterval(tick, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [root]);

  async function pick(kind: "app" | "site") {
    setError(null);
    setLoadingChoices(kind);
    try {
      const { ok, data } = await api({ path: root, action: kind === "app" ? "apps" : "sites" });
      if (!ok) {
        setError(String(data.error ?? "could not list"));
        return;
      }
      const items =
        kind === "app"
          ? ((data.apps ?? []) as { name: string; label: string }[])
          : ((data.sites ?? []) as { name: string; lwr: boolean | null }[]).map((s) => ({
              name: s.name,
              label: s.name,
              lwr: s.lwr,
            }));
      if (items.length === 0) {
        const auraCount = Number(data.auraCount ?? 0);
        setError(
          kind === "site"
            ? auraCount > 0
              ? `no LWR sites in this org - its ${auraCount} Aura site(s) cannot be previewed locally (platform limit); test them by deploying to the sandbox`
              : "no Experience Cloud sites found in the org"
            : "no Lightning apps found",
        );
        return;
      }
      setChoices({ kind, items });
    } finally {
      setLoadingChoices(null);
    }
  }

  async function start(kind: "app" | "site", name: string) {
    setChoices(null);
    setError(null);
    const { ok, data } = await api({ path: root, action: "start", kind, name });
    if (!ok) setError(String(data.error ?? "could not start"));
    else setStatus({ running: true, kind, name, logs: "" });
  }

  async function stop() {
    await api({ path: root, action: "stop" });
    setStatus({ running: false });
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {!status.running ? (
        <div className="flex gap-1.5">
          <button
            onClick={() => pick("app")}
            disabled={loadingChoices !== null}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
            title="Local Dev: your LOCAL UI files rendered against real org data (no deploy). Apex is not previewed."
          >
            {loadingChoices === "app" ? "Loading apps…" : "🖥 Preview app"}
          </button>
          <button
            onClick={() => pick("site")}
            disabled={loadingChoices !== null}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
            title="Local Dev for an LWR Experience Cloud site (Aura sites are not supported by the platform)"
          >
            {loadingChoices === "site" ? "Loading sites…" : "🌐 Preview site"}
          </button>
          <button
            onClick={async () => {
              await api({ path: root, action: "open" });
            }}
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
            title="Open the default org (incl. a default scratch org) in the browser, logged in"
          >
            ↗ Open org
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-sky-500" />
            <span className="truncate text-xs font-medium text-sky-800">
              Local Dev running - {status.kind}: {status.name}
            </span>
            <button
              onClick={stop}
              className="ml-auto rounded border border-sky-300 bg-white px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100"
            >
              Stop
            </button>
          </div>
          {status.prompt && (
            <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-xs text-amber-800">{status.prompt}?</p>
              <div className="mt-1.5 flex gap-2">
                <button
                  onClick={async () => {
                    await api({ path: root, action: "answer", name: "yes" });
                    setStatus((s) => ({ ...s, prompt: null }));
                  }}
                  className="rounded-lg bg-slate-900 px-3 py-1 text-[11px] font-medium text-white hover:bg-slate-700"
                >
                  Yes
                </button>
                <button
                  onClick={async () => {
                    await api({ path: root, action: "answer", name: "no" });
                    setStatus((s) => ({ ...s, prompt: null }));
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-[11px] font-medium hover:bg-slate-50"
                >
                  No
                </button>
              </div>
            </div>
          )}
          {status.logs && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] text-sky-600">server log</summary>
              <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[10px] text-slate-600">
                {status.logs}
              </pre>
            </details>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      {choices && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-6"
          onClick={(e) => e.target === e.currentTarget && setChoices(null)}
        >
          <div className="mt-16 flex max-h-[60vh] w-full max-w-md flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
            <div className="flex items-center">
              <h3 className="text-sm font-semibold">
                {choices.kind === "app" ? "Pick a Lightning app to preview" : "Pick a site to preview"}
              </h3>
              <button
                onClick={() => setChoices(null)}
                className="ml-auto rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
            {choices.kind === "site" && (
              <p className="mt-1 text-[11px] text-amber-600">
                Only LWR sites can be previewed - Aura sites will fail to start (platform limit).
              </p>
            )}
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-100">
              {choices.items.map((i) => {
                const aura = choices.kind === "site" && i.lwr === false;
                return (
                  <button
                    key={i.name}
                    onClick={() => !aura && start(choices.kind, i.name)}
                    disabled={aura}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                      aura ? "cursor-not-allowed opacity-50" : "hover:bg-slate-50"
                    }`}
                    title={aura ? "Aura sites cannot be previewed locally (platform limit)" : undefined}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium">{i.label}</span>
                      {i.label !== i.name && (
                        <span className="truncate font-mono text-[10px] text-slate-400">{i.name}</span>
                      )}
                    </span>
                    {choices.kind === "site" && (
                      <span
                        className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          i.lwr === true
                            ? "bg-emerald-50 text-emerald-600"
                            : i.lwr === false
                              ? "bg-slate-100 text-slate-400"
                              : "bg-amber-50 text-amber-600"
                        }`}
                      >
                        {i.lwr === true ? "LWR" : i.lwr === false ? "Aura" : "unknown"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
