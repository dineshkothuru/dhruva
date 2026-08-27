"use client";

import { useEffect, useRef, useState } from "react";
import pkg from "../../package.json";
import type { DetectionResult } from "@/lib/types";
import FileTree from "@/components/FileTree";
import ProjectSkills from "@/components/ProjectSkills";
import ProjectSettingsPanel from "@/components/ProjectSettingsPanel";
import TeamStandards from "@/components/TeamStandards";
import { trackUi } from "@/lib/track";
import FolderPicker from "@/components/FolderPicker";
import PreviewPanel from "@/components/PreviewPanel";
import EditorPane from "@/components/EditorPane";
import ChatPane from "@/components/ChatPane";
import DiffPane from "@/components/DiffPane";
import WorkflowsPane from "@/components/workflows/WorkflowsPane";
import { Icon } from "@/components/icons";

type Tab = "chat" | "workflows" | "editor" | "setup";

/** POST JSON and parse the response defensively - an empty/non-JSON body
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

  // app_opened is the denominator for every other number: without it an
  // install that never finishes a workflow is invisible. Once per browser
  // session, so a reload during a long run does not inflate the count.
  useEffect(() => {
    try {
      if (sessionStorage.getItem("sfdh.opened")) return;
      sessionStorage.setItem("sfdh.opened", "1");
    } catch {
      /* private mode - reporting once per mount is acceptable */
    }
    trackUi("app_opened");
  }, []);
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(380);
  const connectTarget = useRef("");

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    let lastW = startW;
    function onMove(ev: MouseEvent) {
      const w = Math.min(700, Math.max(240, startW + (ev.clientX - startX)));
      lastW = w;
      setPanelWidth(w);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("sfdh.panelWidth", String(lastW));
      } catch {
        /* quota - persistence is best-effort */
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [jumpToRun, setJumpToRun] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  function openFile(rel: string) {
    setOpenFiles((fs) => (fs.includes(rel) ? fs : [...fs, rel]));
    setActiveFile(rel);
    setTab("editor");
  }

  // Diff views ride the same tab strip as editors, keyed "diff:<rel>".
  // Re-opening a diff bumps its nonce so the pane remounts and refetches -
  // a second agent run on the same file must never show the previous diff.
  const [diffNonce, setDiffNonce] = useState<Record<string, number>>({});
  // Pinned commits per diff tab: set = a historical run's baseline→result;
  // unset = the live HEAD→current diff.
  const [diffPins, setDiffPins] = useState<Record<string, { base?: string; end?: string }>>({});
  const [picking, setPicking] = useState(false);
  function openDiff(rel: string, pin?: { base?: string; end?: string }) {
    setDiffPins((p) => ({ ...p, [rel]: pin ?? {} }));
    setDiffNonce((n) => ({ ...n, [rel]: (n[rel] ?? 0) + 1 }));
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

  async function authorizeOrg(host?: string) {
    if (!result?.path) return;
    setLoginMsg(null);
    const projectPath = result.path;
    const target = norm(projectPath);
    try {
      // reuse the org's known host when re-authorizing - a sandbox login via
      // login.salesforce.com fails the code exchange (invalid_grant)
      const instanceUrl = host ?? result.org?.instanceUrl;
      const { ok, data } = await postJson("/api/org-login", { path: projectPath, instanceUrl });
      if (!ok) {
        setError(String(data.error ?? "Could not start org login"));
        return;
      }
      setLoginMsg("Finish the login in your browser - this panel updates automatically…");
      // poll until the CLI has stored the new authorization (up to 3 minutes)
      for (let i = 0; i < 36; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        if (connectTarget.current !== target) return; // switched projects
        const probe = await postJson("/api/project", { path: projectPath, orgOnly: true });
        const org = probe.ok ? (probe.data.org as DetectionResult["org"]) : undefined;
        if (org?.connected) {
          setResult((r) => (r && norm(r.path) === target ? { ...r, org } : r));
          // stay expanded - the user collapses when done reviewing
          setLoginMsg(`Org authorized: ${org.username}`);
          return;
        }
      }
      setLoginMsg("Still not authorized - finish the browser login, then click Refresh org status.");
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    // Hydrate the last-used path after mount and RECONNECT automatically -
    // a refresh should land back in the attached project, not on the
    // connect form. (localStorage can't be read during render: hydration.)
    const saved = localStorage.getItem("sfdh.lastPath");
    const savedWidth = Number(localStorage.getItem("sfdh.panelWidth"));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (savedWidth >= 240 && savedWidth <= 700) setPanelWidth(savedWidth);
    if (saved) {
      setPath((p) => p || saved);
      connect(saved);
    }
    // connect is stable enough for a mount-only effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(pathOverride?: string) {
    const target = (typeof pathOverride === "string" ? pathOverride : path).trim();
    if (!target || loading) return;
    // Only a DIFFERENT project resets the workspace - reconnecting or
    // refreshing the same one must keep open tabs and chat context.
    const switching = result?.path !== undefined && norm(result.path) !== norm(target);
    connectTarget.current = norm(target);
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
      trackUi("project_attached"); // activation: got past setup into real use

      // Restore this project's workspace (tabs) from a previous session.
      if (!openFiles.length || switching) {
        try {
          const ws = JSON.parse(localStorage.getItem(`sfdh.ws.${norm(target)}`) ?? "null");
          if (ws && Array.isArray(ws.openFiles)) {
            const files = ws.openFiles.slice(0, 20) as string[];
            setOpenFiles(files);
            // the persisted active file may have been truncated away
            setActiveFile(
              typeof ws.activeFile === "string" && files.includes(ws.activeFile)
                ? ws.activeFile
                : (files[0] ?? null),
            );
          }
        } catch {
          /* corrupt workspace entry - start clean */
        }
      }

      // Phase 2: fill the org badge in the background.
      const orgRes = await postJson("/api/project", { path: target, orgOnly: true });
      if (orgRes.ok && orgRes.data.org && connectTarget.current === norm(target)) {
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
    try {
      localStorage.setItem(
        `sfdh.ws.${norm(result.path)}`,
        JSON.stringify({ openFiles: openFiles.slice(0, 20), activeFile }),
      );
    } catch {
      /* quota - persistence is best-effort, never crash the tree */
    }
  }, [connected, result?.path, openFiles, activeFile]);

  // an "editor" tab with no files renders nothing - fall back to chat
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === "editor" && openFiles.length === 0) setTab("chat");
  }, [tab, openFiles.length]);

  // gate indicator: poll the cheap in-memory count so an approval waiting on
  // a human never sits unnoticed while they're in the editor or chat
  const [pendingGates, setPendingGates] = useState(0);
  useEffect(() => {
    if (!connected || !result?.path) return;
    const root = result.path;
    let cancelled = false;
    const tick = async () => {
      try {
        const { ok, data } = await postJson("/api/workflow", { action: "pending", root });
        if (!cancelled && ok) setPendingGates(Number(data.pendingGates ?? 0));
      } catch {
        /* indicator is best-effort */
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connected, result?.path]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left panel - project (resizable via the divider) */}
      <aside
        style={{ width: panelWidth }}
        className="flex shrink-0 flex-col bg-white"
      >
        <div className="bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 px-5 py-4">
          <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-white">
            <svg viewBox="0 0 64 64" className="h-6 w-6 shrink-0 rounded-lg ring-1 ring-white/20" aria-hidden>
              <rect width="64" height="64" rx="14" fill="#0f172a" />
              <path
                d="M32 8 L36.5 27.5 L56 32 L36.5 36.5 L32 56 L27.5 36.5 L8 32 L27.5 27.5 Z"
                fill="#f8fafc"
              />
              <circle cx="32" cy="32" r="3.4" fill="#fbbf24" />
            </svg>
            Dhruva
            <span className="mt-0.5 align-middle text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">
              Salesforce delivery
            </span>
          </h1>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Project folder
          </label>
          <div className="mt-2 flex flex-col gap-2">
            <div className="relative">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()}
                placeholder="D:\my-salesforce-project"
                spellCheck={false}
                className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-3 pr-9 font-mono text-xs shadow-sm outline-none focus:border-slate-500"
              />
              <button
                onClick={() => setPicking(true)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md px-1 py-0.5 text-sm hover:bg-slate-100"
                title="Pick a folder on this machine"
              >
                📁
              </button>
            </div>
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
                <span className="truncate pl-[18px] font-mono text-[11px] text-slate-400">
                  {result.org?.connected
                    ? result.org.instanceUrl?.replace(/^https?:\/\//, "")
                    : "no org authorized"}
                </span>
              </button>
              {detailsOpen && (
                <>
              <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{result.path}</p>

              {/* project facts as a compact chip row - labels are noise here */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600" title="source API version">
                  API {result.sourceApiVersion ?? "?"}
                </span>
                {result.packageDirectories?.map((d) => (
                  <span
                    key={d.path}
                    className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-medium ${
                      d.default ? "bg-indigo-50 text-indigo-600" : "bg-slate-100 text-slate-500"
                    }`}
                    title={d.default ? "default package directory" : "package directory"}
                  >
                    {d.path}
                    {d.default && " ★"}
                  </span>
                ))}
                <span
                  className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                    result.isGitRepo ? "bg-slate-100 text-slate-600" : "bg-slate-50 text-slate-300"
                  }`}
                >
                  {result.isGitRepo ? "git" : "no git"}
                </span>
              </div>

              <dl className="mt-3 text-sm">
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <dt className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                    <span
                      className={`inline-flex h-1.5 w-1.5 rounded-full ${
                        result.org?.connected ? "bg-emerald-500" : "bg-slate-300"
                      }`}
                    />
                    Connected org
                  </dt>
                  <dd className="mt-1.5 text-xs">
                    {result.org?.connected ? (
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate font-semibold text-slate-800" title={result.org.username}>
                          {result.org.username}
                        </span>
                        <span className="truncate font-mono text-[11px] text-slate-400" title={result.org.instanceUrl}>
                          {result.org.instanceUrl?.replace(/^https?:\/\//, "")}
                        </span>
                      </span>
                    ) : (
                      <span className="text-slate-500">{result.org?.reason ?? "no org authorized"}</span>
                    )}
                  </dd>
                  <div className="mt-2.5 flex flex-col gap-2">
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
                      <>
                        {result.org?.connected ? (
                          <button
                            onClick={() => authorizeOrg()}
                            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
                            title="Re-opens the login on this org's own domain"
                          >
                            Re-authorize org
                          </button>
                        ) : result.org?.reason === "checking…" ? null : (
                          <div className="flex flex-col gap-1">
                            <button
                              onClick={() => authorizeOrg("https://test.salesforce.com")}
                              className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
                              title="Opens the sandbox login (test.salesforce.com)"
                            >
                              Authorize org
                            </button>
                            <button
                              onClick={() => authorizeOrg("https://login.salesforce.com")}
                              className="text-left text-[11px] text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
                            >
                              production org instead?
                            </button>
                          </div>
                        )}
                        {result.org?.connected && <PreviewPanel root={result.path} />}
                      </>
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
        {/* attribution footer - version + author, pinned to the panel bottom */}
        <div className="border-t border-slate-100 px-5 py-2.5 text-[11px] text-slate-400">
          Dhruva v{pkg.version} · built by{" "}
          <a
            href="https://www.linkedin.com/in/dinesh-kumar-kothuru/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-slate-500 hover:text-slate-700 hover:underline"
          >
            Dinesh Kumar Kothuru
          </a>
        </div>
      </aside>

      {picking && (
        <FolderPicker
          initialDir={path.trim() || undefined}
          onCancel={() => setPicking(false)}
          onPick={(dir) => {
            setPicking(false);
            setPath(dir);
            void connect(dir);
          }}
        />
      )}

      {/* drag handle - the border line itself resizes the panel */}
      <div
        onMouseDown={startResize}
        className="w-1 shrink-0 cursor-col-resize bg-slate-200 transition-colors hover:bg-slate-400 active:bg-slate-500"
        title="Drag to resize"
      />

      {/* Right panel - chat & workflows (min-w-0: long unbroken output lines
          must wrap inside cards, never widen the panel past the viewport) */}
      <section className="flex min-w-0 flex-1 flex-col overflow-x-hidden bg-slate-50">
        <div className="flex items-center gap-1 border-b border-slate-200 bg-white px-5 py-2">
          <div className="flex items-center gap-0.5 rounded-xl bg-slate-100 p-1">
          {([...(openFiles.length ? (["editor"] as Tab[]) : []), "chat", "workflows", "setup"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                trackUi("feature_used", { feature: t });
              }}
              className={`relative rounded-lg px-3.5 py-1 text-sm font-medium capitalize transition ${
                tab === t
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <span className="mr-1" aria-hidden>
        {t === "editor" ? "" : t === "chat" ? "{<Icon.chat size={13} strokeWidth={1.75} />}" : t === "workflows" ? "{<Icon.workflows size={13} strokeWidth={1.75} />}" : "{<Icon.setup size={13} strokeWidth={1.75} />}"}
              </span>
              {t}
              {t === "workflows" && pendingGates > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400 ring-2 ring-white"
                  title={`${pendingGates} run(s) waiting for your approval`}
                />
              )}
            </button>
          ))}
          </div>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
            {connected && (
              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
            )}
            {connected ? `working in ${result?.projectName}` : "no project attached"}
          </span>
        </div>

        {/* All panes stay MOUNTED and are hidden by CSS - switching tabs must
            never drop the chat transcript or unsaved editor buffers. */}
        {openFiles.length > 0 && result?.path && (
          <div className={`min-h-0 flex-1 flex-col ${tab === "editor" ? "flex" : "hidden"}`}>
            {/* file tab strip - open buffers keep unsaved changes when switching */}
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
                    className="rounded-md px-0.5 text-slate-400 hover:bg-slate-300 hover:text-slate-700"
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
                  <DiffPane
                    key={diffNonce[f.slice(5)] ?? 0}
                    root={result.path}
                    file={f.slice(5)}
                    base={diffPins[f.slice(5)]?.base}
                    end={diffPins[f.slice(5)]?.end}
                  />
                ) : (
                  <EditorPane root={result.path} file={f} />
                )}
              </div>
            ))}
          </div>
        )}

        {connected && result?.path ? (
          <div className={`min-h-0 flex-1 flex-col ${tab === "chat" ? "flex" : "hidden"}`}>
            <ChatPane
              key={result.path}
              root={result.path}
              onOpenDiff={openDiff}
              onRunStarted={(runId) => {
                setJumpToRun(runId);
                setTab("workflows");
              }}
            />
          </div>
        ) : (
          <div className={`flex-1 items-center justify-center px-8 ${tab === "chat" ? "flex" : "hidden"}`}>
            <div className="max-w-md text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-200 text-xl">
                {<Icon.chat size={13} strokeWidth={1.75} />}
              </div>
              <h2 className="mt-4 text-base font-semibold">Agent chat</h2>
              <p className="mt-1.5 text-sm text-slate-500">
                Attach a Salesforce project on the left to start.
              </p>
            </div>
          </div>
        )}

        {connected && result?.path ? (
          <div className={`min-h-0 flex-1 flex-col ${tab === "workflows" ? "flex" : "hidden"}`}>
            <WorkflowsPane
              key={result.path}
              root={result.path}
              onOpenDiff={openDiff}
              jumpToRun={jumpToRun}
              onJumpConsumed={() => setJumpToRun(null)}
            />
          </div>
        ) : (
          <div
            className={`flex-1 items-center justify-center px-8 ${
              tab === "workflows" ? "flex" : "hidden"
            }`}
          >
            <p className="text-sm text-slate-500">Attach a Salesforce project to run workflows.</p>
          </div>
        )}

        {connected && result?.path ? (
          <div className={`min-h-0 flex-1 overflow-y-auto p-6 ${tab === "setup" ? "block" : "hidden"}`}>
            <h2 className="text-base font-semibold tracking-tight text-slate-800">Project setup</h2>
            <div className="mt-1.5 h-0.5 w-10 rounded-full bg-gradient-to-r from-indigo-500 to-sky-400" />
            <p className="mt-1 text-xs text-slate-500">
              Per-project knowledge and configuration - stored under .dhruva/ inside{" "}
              {result.projectName}, applied to every agent working in this project.
            </p>
            {/* what you configure on the left, what ships with Dhruva on the
                right - splits at lg so a laptop already gets two columns */}
            <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                <ProjectSkills
                  key={`skills-${result.path}`}
                  root={result.path}
                  onOpenFile={openFile}
                  active={tab === "setup"}
                />
                <div className="rounded-xl border border-slate-200 bg-white">
                  <ProjectSettingsPanel key={`pset-${result.path}`} root={result.path} />
                </div>
              </div>
              <TeamStandards active={tab === "setup"} />
            </div>
          </div>
        ) : (
          <div className={`flex-1 items-center justify-center px-8 ${tab === "setup" ? "flex" : "hidden"}`}>
            <p className="text-sm text-slate-500">Attach a Salesforce project to configure it.</p>
          </div>
        )}
      </section>

    </div>
  );
}
