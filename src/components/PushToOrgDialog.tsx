"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

/** The confirmation in front of the editor's only write-to-org action.
 *
 * This dialog IS the human gate. Everywhere else in Dhruva a deploy sits behind
 * a workflow `gate` step, and validate.ts refuses a workflow that deploys
 * without one. A button in the editor has no workflow around it, so the gate
 * has to live here - which means it has to do the job a real gate does:
 *
 *  - Name the ORG, prominently, before anything can be clicked. The failure
 *    being guarded against is deploying to the wrong org, and a dialog that
 *    only says "Deploy?" does nothing about it.
 *  - Offer VALIDATE first and make it the default-looking action. "Will this
 *    compile there?" is the actual question most of the time, and it saves
 *    nothing to the org.
 *  - Say plainly that deploy is immediate and not undoable. No workflow is
 *    recording this, and no gate follows it.
 *
 * The org name shown here is echoed back to the server as `confirmOrg`, and the
 * server refuses the deploy if the project's org has changed since - so this is
 * not decoration that a stale dialog can bypass. */

interface OrgInfo {
  connected: boolean;
  username?: string;
  instanceUrl?: string;
  reason?: string;
}

interface Result {
  ok: boolean;
  checkOnly: boolean;
  message: string;
  files?: { fullName?: string; type?: string; state?: string; error?: string }[];
  deployId?: string;
  componentCount?: number;
}

export default function PushToOrgDialog({
  root,
  file,
  onClose,
}: {
  root: string;
  file: string;
  onClose: () => void;
}) {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "deploy">("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/deploy-file?root=${encodeURIComponent(root)}`);
        const d = await res.json();
        if (!cancelled) setOrg(res.ok ? (d.org as OrgInfo) : { connected: false, reason: d.error });
      } catch (e) {
        if (!cancelled) setOrg({ connected: false, reason: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root]);

  // A deploy compiles Apex in the org and can take a while; a silent button is
  // indistinguishable from a hung one.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function run(checkOnly: boolean) {
    if (busy || !org?.username) return;
    setBusy(checkOnly ? "check" : "deploy");
    setElapsed(0);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/deploy-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, file, checkOnly, confirmOrg: org.username }),
      });
      const d = await res.json();
      if (d && typeof d.message === "string") setResult(d as Result);
      else setError(String(d?.error ?? "deploy failed"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }

  const name = file.split("/").pop() ?? file;
  const ready = org?.connected === true && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 p-6 pt-[8vh]"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800">Push to org</h2>
          <button
            onClick={onClose}
            disabled={!!busy}
            className="ml-auto rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
            title="Close"
          >
            <Icon.close size={14} strokeWidth={2.25} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          {/* The org, first and largest. This is the whole point of the gate. */}
          <div className="rounded-lg bg-slate-50 px-3 py-2.5 ring-1 ring-inset ring-slate-200">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Deploying to
            </span>
            {org === null ? (
              <p className="text-xs text-slate-400">checking…</p>
            ) : org.connected ? (
              <>
                <p className="truncate font-mono text-[13px] font-semibold text-slate-800">
                  {org.username}
                </p>
                {org.instanceUrl && (
                  <p className="truncate font-mono text-[11px] text-slate-500">
                    {org.instanceUrl.replace(/^https?:\/\//, "")}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-red-600">{org.reason ?? "no org authorized"}</p>
            )}
          </div>

          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Component
            </span>
            <p className="truncate font-mono text-[12px] text-slate-700" title={file}>
              {name}
            </p>
            <p className="truncate font-mono text-[11px] text-slate-400" title={file}>
              {file.split("/").slice(0, -1).join("/")}
            </p>
            {/* A bundle is not deployable in pieces, and people are surprised
                by that if it is not said. */}
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              The whole component is deployed, not just this file — an LWC or Aura bundle goes as a
              unit.
            </p>
          </div>

          {result && (
            <div
              className={`rounded-lg px-3 py-2 text-[11px] leading-relaxed ring-1 ring-inset ${
                result.ok
                  ? result.checkOnly
                    ? "bg-sky-50 text-sky-800 ring-sky-100"
                    : "bg-emerald-50 text-emerald-800 ring-emerald-100"
                  : "bg-red-50 text-red-700 ring-red-100"
              }`}
            >
              <p className="font-semibold">{result.message}</p>
              {result.componentCount !== undefined && (
                <p className="mt-0.5 opacity-80">{result.componentCount} component(s)</p>
              )}
              {(result.files ?? [])
                .filter((f) => f.error)
                .slice(0, 4)
                .map((f, i) => (
                  <p key={i} className="mt-1 font-mono">
                    {f.fullName}: {f.error}
                  </p>
                ))}
              {result.deployId && (
                <p className="mt-1 font-mono opacity-70">deploy id {result.deployId}</p>
              )}
            </div>
          )}

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700 ring-1 ring-inset ring-red-100">
              {error}
            </p>
          )}

          {/* Said before the button, not after it. */}
          <p className="text-[11px] leading-relaxed text-amber-700">
            <Icon.warn size={11} strokeWidth={2.25} className="mr-1 inline align-[-1px]" />
            A deploy takes effect immediately and cannot be undone from here. No workflow gate or
            review runs in front of it.
          </p>
        </div>

        <div className="flex items-center gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <p className="text-[11px] text-slate-400">
            {busy ? `${busy === "check" ? "Validating" : "Deploying"}… ${elapsed}s` : "Sends what is on disk."}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={!!busy}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-100 disabled:opacity-40"
            >
              Cancel
            </button>
            {/* Validate is offered first and styled as the safe default. */}
            <button
              onClick={() => void run(true)}
              disabled={!ready}
              className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-40"
              title="Compile and validate in the org without saving anything (sf --dry-run)"
            >
              {busy === "check" ? "Validating…" : "Validate only"}
            </button>
            <button
              onClick={() => void run(false)}
              disabled={!ready}
              className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
              title="Deploy the component to the org named above"
            >
              {busy === "deploy" ? "Deploying…" : "Deploy"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
