"use client";

import { useEffect, useState } from "react";
import type { DetectionResult } from "@/lib/types";

type Tab = "chat" | "workflows";

export default function Home() {
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [loginMsg, setLoginMsg] = useState<string | null>(null);

  async function initProject() {
    const target = path.trim();
    if (!target || loading) return;
    const ok = window.confirm(
      `Create a new Salesforce DX project at:\n\n${target}\n\nThe folder will be created if it doesn't exist and the standard structure (force-app, sfdx-project.json, …) scaffolded inside it.`,
    );
    if (!ok) return;
    setLoading(true);
    setError(null);
    setLoginMsg(null);
    try {
      const res = await fetch("/api/init-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create the project");
      } else {
        setResult(data as DetectionResult);
        localStorage.setItem("sfdh.lastPath", target);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function authorizeOrg(instanceUrl: string) {
    if (!result?.path) return;
    setLoginMsg(null);
    try {
      const res = await fetch("/api/org-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: result.path, instanceUrl }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Could not start org login");
      else setLoginMsg(data.message);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    // Hydrate the last-used path after mount; reading localStorage during
    // render (or a lazy initializer) mismatches the server-rendered HTML.
    const saved = localStorage.getItem("sfdh.lastPath");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setPath((p) => p || saved);
  }, []);

  async function connect() {
    if (!path.trim() || loading) return;
    setLoading(true);
    setError(null);
    setLoginMsg(null);
    setResult(null);
    try {
      const res = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Request failed");
      } else {
        setResult(data as DetectionResult);
        localStorage.setItem("sfdh.lastPath", path.trim());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const connected = result?.status === "connected";

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left panel — project */}
      <aside className="flex w-[30%] min-w-[320px] flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h1 className="text-lg font-semibold tracking-tight">SF Delivery Harness</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Attach a Salesforce project folder. The harness works inside it.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Project folder
          </label>
          <div className="mt-2 flex flex-col gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connect()}
              placeholder="D:\my-salesforce-project"
              spellCheck={false}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs shadow-sm outline-none focus:border-slate-500"
            />
            <button
              onClick={connect}
              disabled={loading || !path.trim()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-700 disabled:opacity-40"
            >
              {loading ? "Checking…" : "Connect"}
            </button>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          {result && connected && (
            <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <span className="text-sm font-semibold text-emerald-700">Connected</span>
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{result.path}</p>

              <dl className="mt-4 space-y-3 text-sm">
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-400">Project</dt>
                  <dd className="mt-0.5 font-medium">{result.projectName ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-400">API version</dt>
                  <dd className="mt-0.5 font-medium">{result.sourceApiVersion ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-400">
                    Package directories
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {result.packageDirectories?.length
                      ? result.packageDirectories.map((d) => (
                          <div key={d.path}>
                            {d.path}
                            {d.default && <span className="ml-1 text-slate-400">(default)</span>}
                          </div>
                        ))
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-400">Git</dt>
                  <dd className="mt-1">
                    {result.isGitRepo ? (
                      <span className="rounded bg-slate-200 px-2 py-0.5 text-xs font-medium">
                        git repo
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">not a git repo</span>
                    )}
                  </dd>
                </div>
                <div className="border-t border-slate-200 pt-3">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-400">Default org</dt>
                  <dd className="mt-1 text-xs">
                    {result.org?.connected ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                          <span className="font-medium">{result.org.username}</span>
                        </span>
                        <span className="pl-4 text-slate-400">{result.org.instanceUrl}</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2 text-slate-500">
                        <span className="inline-flex h-2 w-2 rounded-full bg-slate-300" />
                        {result.org?.reason ?? "no org authorized"}
                      </span>
                    )}
                  </dd>
                  <div className="mt-3 flex flex-col gap-2">
                    {loginMsg ? (
                      <>
                        <p className="text-[11px] text-sky-700">{loginMsg}</p>
                        <button
                          onClick={connect}
                          disabled={loading}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
                        >
                          {loading ? "Checking…" : "Refresh org status"}
                        </button>
                      </>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => authorizeOrg("https://login.salesforce.com")}
                          className="flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
                        >
                          {result.org?.connected ? "Re-authorize" : "Authorize org"}
                        </button>
                        <button
                          onClick={() => authorizeOrg("https://test.salesforce.com")}
                          className="flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
                        >
                          Sandbox login
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </dl>
            </div>
          )}

          {result && !connected && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
                <span className="text-sm font-semibold text-amber-800">
                  {result.status === "not_found" ? "Folder not found" : "Not a Salesforce project"}
                </span>
              </div>
              <p className="mt-2 text-xs text-amber-700">{result.message}</p>
              {(result.status === "not_found" || result.isEmptyFolder) && (
                <button
                  onClick={initProject}
                  disabled={loading}
                  className="mt-3 w-full rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                >
                  {loading ? "Creating…" : "Create Salesforce project here"}
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Right panel — chat & workflows */}
      <section className="flex flex-1 flex-col bg-slate-50">
        <div className="flex items-center gap-1 border-b border-slate-200 bg-white px-5 py-2.5">
          {(["chat", "workflows"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3.5 py-1.5 text-sm font-medium capitalize transition ${
                tab === t
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              }`}
            >
              {t}
            </button>
          ))}
          <span className="ml-auto text-xs text-slate-400">
            {connected ? `working in ${result?.projectName}` : "no project attached"}
          </span>
        </div>

        {tab === "chat" ? (
          <div className="flex flex-1 flex-col">
            <div className="flex flex-1 items-center justify-center px-8">
              <div className="max-w-md text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-200 text-xl">
                  💬
                </div>
                <h2 className="mt-4 text-base font-semibold">Agent chat</h2>
                <p className="mt-1.5 text-sm text-slate-500">
                  {connected
                    ? "The Copilot CLI adapter lands in the next phase — you'll describe a task here and the agent will work inside the attached project."
                    : "Attach a Salesforce project on the left to start."}
                </p>
              </div>
            </div>
            <div className="border-t border-slate-200 bg-white p-4">
              <div className="flex gap-2">
                <input
                  disabled
                  placeholder={
                    connected
                      ? "Describe a task… (agent adapter coming next)"
                      : "Attach a project first"
                  }
                  className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400"
                />
                <button
                  disabled
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white opacity-40"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <h2 className="text-sm font-semibold text-slate-700">Delivery workflows</h2>
            <p className="mt-1 text-xs text-slate-500">
              Guarded, repeatable delivery steps that run inside the attached project. Coming in the
              next phases.
            </p>
            <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[
                ["🚀", "Validate deploy", "Check-only deploy to the default org with test-level enforcement."],
                ["🧪", "Run Apex tests", "Run local tests and surface coverage per class."],
                ["🛡️", "Prod guard", "Detects production orgs and blocks unguarded deploys."],
                ["📦", "Package diff", "Diff local source against the org before delivery."],
                ["🧹", "Code scan", "Static analysis on Apex/LWC before a PR."],
                ["🔁", "Sandbox sync", "Pull org changes into source, review, and commit."],
              ].map(([icon, title, desc]) => (
                <div
                  key={title}
                  className="rounded-xl border border-slate-200 bg-white p-4 opacity-70"
                >
                  <div className="text-lg">{icon}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-sm font-semibold">{title}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                      soon
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
