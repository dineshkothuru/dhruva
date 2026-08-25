"use client";

import { useEffect, useState } from "react";
import type { DetectionResult } from "@/lib/types";
import FileTree from "@/components/FileTree";
import EditorPane from "@/components/EditorPane";
import ChatPane from "@/components/ChatPane";
import DiffPane from "@/components/DiffPane";

type Tab = "chat" | "workflows" | "editor";

/** POST JSON and parse the response defensively — an empty/non-JSON body
 * (crashed route, dev-server rebuild) becomes a readable error, not a
 * "Unexpected end of JSON input" exception. */
async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: `Server returned an unexpected response (HTTP ${res.status})` };
  }
  return { ok: res.ok, data };
}

/** Normalize a path for equality/storage keys (case+separator-insensitive). */
function norm(p: string) {
  return p.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export default function Home() {
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  function openFile(rel: string) {
    setOpenFiles((fs) => (fs.includes(rel) ? fs : [...fs, rel]));
    setActiveFile(rel);
    setTab("editor");
  }

  // Diff views ride the same tab strip as editors, keyed "diff:<rel>".
  function openDiff(rel: string) {
    openFile(`diff:${rel}`);
  }

  function closeFile(rel: string) {
    setOpenFiles((fs) => {
      const next = fs.filter((f) => f !== rel);
      if (activeFile === rel) {
        const idx = fs.indexOf(rel);
        const neighbor = next[Math.min(idx, next.length - 1)] ?? null;
        setActiveFile(neighbor);
        if (!neighbor) setTab("chat");
      }
      return next;
    });
  }

  async function initProject() {
    const target = path.trim();
    if (!target || loading) return;
    setLoading(true);
    setError(null);
    setLoginMsg(null);
    try {
      const { ok, data } = await postJson("/api/init-project", { path: target });
      if (!ok) {
        setError(String(data.error ?? "Could not create the project"));
      } else {
        const det = data as unknown as DetectionResult;
        setResult(det);
        setDetailsOpen(!det.org?.connected);
        localStorage.setItem("sfdh.lastPath", target);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function authorizeOrg() {
    if (!result?.path) return;
    setLoginMsg(null);
    try {
      const { ok, data } = await postJson("/api/org-login", { path: result.path });
      if (!ok) setError(String(data.error ?? "Could not start org login"));
      else setLoginMsg(String(data.message ?? "Login started — finish in your browser."));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    // Hydrate the last-used path after mount and RECONNECT automatically —
    // a refresh should land back in the attached project, not on the
    // connect form. (localStorage can't be read during render: hydration.)
    const saved = localStorage.getItem("sfdh.lastPath");
    if (saved) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPath((p) => p || saved);
      connect(saved);
    }
    // connect is stable enough for a mount-only effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(pathOverride?: string) {
    const target = (typeof pathOverride === "string" ? pathOverride : path).trim();
    if (!target || loading) return;
    // Only a DIFFERENT project resets the workspace — reconnecting or
    // refreshing the same one must keep open tabs and chat context.
    const switching = result?.path !== undefined && norm(result.path) !== norm(target);
    setLoading(true);
    setError(null);
    setLoginMsg(null);
    if (switching) {
      setResult(null);
      setOpenFiles([]);
      setActiveFile(null);
      setTab((t) => (t === "editor" ? "chat" : t));
    }
    try {
      // Phase 1: instant repo-level result (no slow sf CLI probe).
      const { ok, data } = await postJson("/api/project", { path: target, skipOrg: true });
      if (!ok) {
        setError(String(data.error ?? "Request failed"));
        return;
      }
      const det = data as unknown as DetectionResult;
      setResult(det);
      localStorage.setItem("sfdh.lastPath", target);
      setLoading(false);
      if (det.status !== "connected") return;

      // Restore this project's workspace (tabs) from a previous session.
      if (!openFiles.length || switching) {
        try {
          const ws = JSON.parse(localStorage.getItem(`sfdh.ws.${norm(target)}`) ?? "null");
          if (ws && Array.isArray(ws.openFiles)) {
            setOpenFiles(ws.openFiles.slice(0, 20));
            setActiveFile(typeof ws.activeFile === "string" ? ws.activeFile : null);
          }
        } catch {
          /* corrupt workspace entry — start clean */
        }
      }

      // Phase 2: fill the org badge in the background.
      const orgRes = await postJson("/api/project", { path: target, orgOnly: true });
      if (orgRes.ok && orgRes.data.org) {
        const org = orgRes.data.org as DetectionResult["org"];
        setResult((r) => (r && norm(r.path) === norm(target) ? { ...r, org } : r));
        setDetailsOpen(!org?.connected); // keep authorize visible until an org is set
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const connected = result?.status === "connected";

  // Persist the workspace (open tabs) per project so refreshes restore it.
  useEffect(() => {
    if (!connected || !result?.path) return;
    localStorage.setItem(
      `sfdh.ws.${norm(result.path)}`,
      JSON.stringify({ openFiles, activeFile }),
    );
  }, [connected, result?.path, openFiles, activeFile]);

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
              onClick={() => connect()}
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
              <button
                onClick={() => setDetailsOpen(!detailsOpen)}
                className="flex w-full flex-col gap-0.5 text-left"
                title={result.path}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                  <span className="truncate text-sm font-semibold text-emerald-700">
                    {result.projectName ?? "Connected"}
                  </span>
                  <span
                    className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                      result.org?.connected ? "bg-emerald-500" : "bg-slate-300"
                    }`}
                    title={result.org?.connected ? result.org.username : "no org authorized"}
                  />
                  <span className="ml-auto text-xs text-slate-400">{detailsOpen ? "▾" : "▸"}</span>
                </span>
                <span className="truncate pl-[18px] font-mono text-[10px] text-slate-400">
                  {result.org?.connected
                    ? result.org.instanceUrl?.replace(/^https?:\/\//, "")
                    : "no org authorized"}
                </span>
              </button>
              {detailsOpen && (
                <>
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
                          onClick={() => connect()}
                          disabled={loading}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
                        >
                          {loading ? "Checking…" : "Refresh org status"}
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => authorizeOrg()}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
                        title="Opens the Salesforce login in your browser — use 'Use Custom Domain' there for sandboxes or my-domain orgs"
                      >
                        {result.org?.connected ? "Re-authorize org" : "Authorize org"}
                      </button>
                    )}
                  </div>
                </div>
              </dl>
                </>
              )}
            </div>
          )}

          {result && connected && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                Files
              </div>
              <FileTree
                key={result.path}
                root={result.path}
                onOpenFile={openFile}
                selected={activeFile}
                defaultDir={
                  result.packageDirectories?.find((d) => d.default)?.path ??
                  result.packageDirectories?.[0]?.path
                }
              />
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
                  {loading
                    ? "Creating project… (takes ~15s)"
                    : "Create Salesforce project here"}
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Right panel — chat & workflows */}
      <section className="flex flex-1 flex-col bg-slate-50">
        <div className="flex items-center gap-1 border-b border-slate-200 bg-white px-5 py-2.5">
          {([...(openFiles.length ? (["editor"] as Tab[]) : []), "chat", "workflows"] as Tab[]).map((t) => (
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

        {/* All panes stay MOUNTED and are hidden by CSS — switching tabs must
            never drop the chat transcript or unsaved editor buffers. */}
        {openFiles.length > 0 && result?.path && (
          <div className={`min-h-0 flex-1 flex-col ${tab === "editor" ? "flex" : "hidden"}`}>
            {/* file tab strip — open buffers keep unsaved changes when switching */}
            <div className="flex items-center gap-0.5 overflow-x-auto border-b border-slate-200 bg-slate-100 px-2 pt-1.5">
              {openFiles.map((f) => (
                <span
                  key={f}
                  className={`group flex shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs ${
                    activeFile === f
                      ? "border-slate-200 bg-white font-medium"
                      : "border-transparent text-slate-500 hover:bg-slate-200"
                  }`}
                >
                  <button onClick={() => setActiveFile(f)} title={f} className="max-w-[180px] truncate">
                    {(f.startsWith("diff:") ? "Δ " : "") + f.split("/").pop()}
                  </button>
                  <button
                    onClick={() => closeFile(f)}
                    className="rounded px-0.5 text-slate-400 hover:bg-slate-300 hover:text-slate-700"
                    title="Close"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            {openFiles.map((f) => (
              <div key={f} className={`min-h-0 flex-1 ${activeFile === f ? "" : "hidden"}`}>
                {f.startsWith("diff:") ? (
                  <DiffPane root={result.path} file={f.slice(5)} />
                ) : (
                  <EditorPane root={result.path} file={f} />
                )}
              </div>
            ))}
          </div>
        )}

        {connected && result?.path ? (
          <div className={`min-h-0 flex-1 flex-col ${tab === "chat" ? "flex" : "hidden"}`}>
            <ChatPane key={result.path} root={result.path} onOpenDiff={openDiff} />
          </div>
        ) : (
          <div className={`flex-1 items-center justify-center px-8 ${tab === "chat" ? "flex" : "hidden"}`}>
            <div className="max-w-md text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-200 text-xl">
                💬
              </div>
              <h2 className="mt-4 text-base font-semibold">Agent chat</h2>
              <p className="mt-1.5 text-sm text-slate-500">
                Attach a Salesforce project on the left to start.
              </p>
            </div>
          </div>
        )}

        {tab === "workflows" && (
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
