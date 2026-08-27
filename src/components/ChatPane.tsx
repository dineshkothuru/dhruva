"use client";

import { useEffect, useRef, useState } from "react";
import { loadDefaultAgent } from "@/lib/agentStore";
import type { AgentId } from "@/lib/agents";
import { estimateUsage, formatUsage } from "@/lib/pricing";
import { classifyIntake } from "@/lib/intake";
import { rolesFor } from "@/lib/roleStore";

interface Msg {
  role: "user" | "agent" | "system" | "changes" | "proposal";
  agent?: AgentId;
  text: string;
  changes?: { file: string; status: string }[];
  usage?: string;
  /** proposal: the task text + suggested workflow awaiting the user's choice */
  proposal?: { taskText: string; workflow: string; title: string; reason: string; resolved?: string };
}

interface AgentStatus {
  label: string;
  installed: boolean;
  version?: string;
  installHint: string;
  models: { id: string; label: string }[];
}

const AGENT_ORDER: AgentId[] = ["copilot", "claude", "codex", "cursor"];
const CUSTOM = "__custom__";

function chatKey(root: string) {
  return `sfdh.chat.${root.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()}`;
}

/** Cap what we persist: last 60 messages, agent outputs trimmed. */
function toPersistable(messages: Msg[]): Msg[] {
  return messages.slice(-60).map((m) => ({
    ...m,
    text: m.text.length > 20_000 ? `${m.text.slice(0, 20_000)}\n…[truncated]` : m.text,
  }));
}

export default function ChatPane({
  root,
  onOpenDiff,
  onRunStarted,
}: {
  root: string;
  onOpenDiff?: (rel: string) => void;
  /** Called when an intake proposal starts a workflow run - the app switches
   * to the Workflows tab and opens the run. */
  onRunStarted?: (runId: string) => void;
}) {
  const [status, setStatus] = useState<Record<string, AgentStatus> | null>(null);
  // default agent (user setting) preselected; switching stays per-session
  const [agent, setAgent] = useState<AgentId>(() => loadDefaultAgent() ?? "copilot");
  // model per agent - persisted as the DEFAULT: whatever you pick is
  // remembered and taken automatically every session, no re-input needed
  const [models, setModels] = useState<Partial<Record<AgentId, string>>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("sfdh.chatModels") ?? "null");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  });
  function rememberModel(id: AgentId, value: string) {
    setModels((m) => {
      const next = { ...m, [id]: value };
      try {
        localStorage.setItem("sfdh.chatModels", JSON.stringify(next));
      } catch {
        /* best-effort */
      }
      return next;
    });
  }
  const [custom, setCustom] = useState<Partial<Record<AgentId, boolean>>>({});
  const [input, setInput] = useState("");
  // ChatPane only mounts after a project connects (post-hydration), so a
  // lazy localStorage read is safe here - transcripts persist per project.
  const [messages, setMessages] = useState<Msg[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(chatKey(root)) ?? "null");
      return Array.isArray(saved) ? (saved as Msg[]) : [];
    } catch {
      return [];
    }
  });
  const [running, setRunning] = useState(false);
  const [attachments, setAttachments] = useState<{ rel: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, 8)) {
        const fd = new FormData();
        fd.append("root", root);
        fd.append("file", f);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (res.ok) {
          setAttachments((a) => [...a, { rel: String(data.rel), name: String(data.name) }]);
        } else {
          setMessages((m) => [...m, { role: "system", text: String(data.error ?? "upload failed") }]);
        }
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent-status")
      .then((r) => r.json())
      .then((s: Record<string, AgentStatus>) => {
        if (cancelled) return;
        setStatus(s);
        const firstInstalled = AGENT_ORDER.find((id) => s[id]?.installed);
        if (firstInstalled) setAgent(firstInstalled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    // Persist the transcript (skip mid-stream churn: only when not running).
    if (!running) {
      try {
        localStorage.setItem(chatKey(root), JSON.stringify(toPersistable(messages)));
      } catch {
        /* storage full - transcript persistence is best-effort */
      }
    }
  }, [messages, running, root]);

  async function send() {
    const prompt = input.trim();
    if (!prompt || running) return;
    // Task-first intake: delivery-shaped text proposes the matching workflow
    // (deterministic classifier; the user confirms - nothing starts silently).
    // attachments ride along as project-relative paths the agents can read
    const attached = attachments.map((a) => a.rel);
    const taskText =
      attached.length > 0
        ? `${prompt}\n\nAttached files (read them from the project root): ${attached.join(", ")}`
        : prompt;
    const proposal = classifyIntake(prompt);
    if (proposal) {
      setInput("");
      setAttachments([]);
      setMessages((m) => [
        ...m,
        {
          role: "user",
          text: prompt + (attached.length ? `\nAttached: ${attachments.map((a) => a.name).join(", ")}` : ""),
        },
        {
          role: "proposal",
          text: "",
          proposal: { taskText, ...proposal },
        },
      ]);
      return;
    }
    setInput("");
    setAttachments([]);
    await runAgentChat(prompt, true, attached);
  }

  /** Plain agent chat (streaming) - also the "just chat" path of a proposal. */
  async function runAgentChat(prompt: string, addUserMsg: boolean, attached: string[] = []) {
    if (running) return;
    if (!status?.[agent]?.installed) {
      setMessages((m) => [
        ...m,
        { role: "system", text: `${agent} is not installed: ${status?.[agent]?.installHint ?? ""}` },
      ]);
      return;
    }
    setRunning(true);
    setMessages((m) => [
      ...m,
      ...(addUserMsg ? [{ role: "user", text: prompt } as Msg] : []),
      { role: "agent", agent, text: "" },
    ]);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root,
          agent,
          prompt,
          model: models[agent] ?? status?.[agent]?.models?.[0]?.id ?? "",
          attachments: attached,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text();
        // drop the empty agent bubble; show the error instead
        setMessages((m) => [
          ...m.filter((x, i) => !(i === m.length - 1 && x.role === "agent" && !x.text)),
          { role: "system", text: err || `HTTP ${res.status}` },
        ]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const append = (chunk: string) => {
        if (!chunk) return;
        setMessages((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          if (last?.role === "agent") next[next.length - 1] = { ...last, text: last.text + chunk };
          return next;
        });
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
      append(decoder.decode()); // flush a trailing multi-byte character
    } catch (e) {
      setMessages((m) => [...m, { role: "system", text: String(e) }]);
    } finally {
      setRunning(false);
    }
    // Informational usage: what would this exchange cost at public API rates
    setMessages((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      if (last?.role === "agent") {
        const u = estimateUsage(agent, models[agent], prompt, last.text);
        next[next.length - 1] = { ...last, usage: formatUsage(u) };
      }
      return next;
    });
    // Deterministic review: what did this run change since the snapshot?
    try {
      const res = await fetch("/api/changes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      });
      const d = await res.json();
      if (res.ok && Array.isArray(d.changes) && d.changes.length > 0) {
        setMessages((m) => [
          ...m,
          { role: "changes", text: `${d.changes.length} file(s) changed`, changes: d.changes },
        ]);
      }
    } catch {
      /* review is best-effort; the agent output above still stands */
    }
  }

  /** Start a workflow from an intake proposal and hand off to the run view. */
  async function startWorkflowFromProposal(msgIndex: number, workflowId: string) {
    const msg = messages[msgIndex];
    if (!msg?.proposal || msg.proposal.resolved) return;
    // synchronous guard: a double-click must not start two real runs
    markProposal(msgIndex, "starting…");
    const inputsMap: Record<string, Record<string, string | boolean>> = {
      "bug-fix": { description: msg.proposal.taskText, runTests: false, deploy: false },
      "feature-dev": { requirement: msg.proposal.taskText, runTests: true, deploy: false },
      "solution-design": { requirement: msg.proposal.taskText, docName: "solution-design" },
    };
    try {
      const res = await fetch("/api/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          root,
          workflow: workflowId,
          inputs: inputsMap[workflowId] ?? { description: msg.proposal.taskText },
          agent,
          model: models[agent] ?? status?.[agent]?.models?.[0]?.id ?? "",
          roleModels: rolesFor(agent),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        markProposal(msgIndex, `failed: ${String(data.error ?? "could not start workflow")}`);
        return;
      }
      markProposal(msgIndex, `started ${workflowId} run ${data.runId}`);
      onRunStarted?.(String(data.runId));
    } catch (e) {
      setMessages((m) => [...m, { role: "system", text: String(e) }]);
    }
  }

  function markProposal(msgIndex: number, resolved: string) {
    setMessages((m) =>
      m.map((msg, i) =>
        i === msgIndex && msg.proposal ? { ...msg, proposal: { ...msg.proposal, resolved } } : msg,
      ),
    );
  }

  const current = status?.[agent];
  const isCustomModel = custom[agent] === true;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* agent picker */}
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <span className="text-xs text-slate-400">Agent:</span>
        {AGENT_ORDER.map((id) => {
          const s = status?.[id];
          return (
            <button
              key={id}
              onClick={() => setAgent(id)}
              disabled={running || s?.installed === false}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium ${
                agent === id
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              } disabled:opacity-50`}
              title={s ? (s.installed ? (s.version ?? "installed") : s.installHint) : "checking…"}
            >
              <span
                className={`inline-flex h-1.5 w-1.5 rounded-full ${
                  s == null ? "bg-slate-300" : s.installed ? "bg-emerald-500" : "bg-red-400"
                }`}
              />
              {s?.label ?? id}
            </button>
          );
        })}
        {current?.installed && current.models?.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5">
            {isCustomModel && (
              <input
                value={models[agent] ?? ""}
                onChange={(e) => rememberModel(agent, e.target.value)}
                placeholder="model id, e.g. claude-sonnet-5"
                spellCheck={false}
                disabled={running}
                className="w-44 rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-xs outline-none focus:border-slate-400 disabled:opacity-50"
              />
            )}
            <select
              value={isCustomModel ? CUSTOM : (models[agent] ?? current.models[0].id)}
              onChange={(e) => {
                if (e.target.value === CUSTOM) {
                  setCustom((c) => ({ ...c, [agent]: true }));
                  rememberModel(agent, "");
                } else {
                  setCustom((c) => ({ ...c, [agent]: false }));
                  rememberModel(agent, e.target.value);
                }
              }}
              disabled={running}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 outline-none focus:border-slate-400 disabled:opacity-50"
              title="Model the agent runs with - your pick is saved as the default and used automatically from then on"
            >
              {current.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value={CUSTOM}>Custom…</option>
            </select>
          </div>
        )}
      </div>

      {/* transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-200 text-xl">
                💬
              </div>
              <h2 className="mt-4 text-base font-semibold">Agent chat</h2>
              <p className="mt-1.5 text-sm text-slate-500">
                Describe a task - the selected agent works inside the attached project and its
                output streams here.
              </p>
              {current && !current.installed && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {current.label} is not installed: {current.installHint}
                </p>
              )}
            </div>
          </div>
        )}
        <div className="space-y-4">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-slate-900 px-4 py-2.5 text-sm text-white">
                {m.text}
              </div>
            ) : m.role === "agent" ? (
              <div key={i} className="max-w-full rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-3">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  {status?.[m.agent ?? "copilot"]?.label ?? m.agent}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-slate-700">
                  {m.text || (running && i === messages.length - 1 ? "working…" : "")}
                </pre>
                {m.usage && (
                  <p className="mt-2 border-t border-slate-100 pt-1.5 text-[10px] text-slate-400">
                    {m.usage}
                  </p>
                )}
              </div>
            ) : m.role === "proposal" && m.proposal ? (
              <div key={i} className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3">
                <p className="text-sm text-sky-900">
                  This looks like a <span className="font-semibold">{m.proposal.title}</span> task
                  ({m.proposal.reason}).
                </p>
                {m.proposal.resolved ? (
                  <p className="mt-2 text-xs text-sky-700">→ {m.proposal.resolved}</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => startWorkflowFromProposal(i, m.proposal!.workflow)}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
                    >
                      Run {m.proposal.title} workflow
                    </button>
                    {(["bug-fix", "feature-dev", "solution-design"] as const)
                      .filter((w) => w !== m.proposal!.workflow)
                      .map((w) => (
                        <button
                          key={w}
                          onClick={() => startWorkflowFromProposal(i, w)}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
                        >
                          {w === "bug-fix"
                            ? "Bug fix instead"
                            : w === "feature-dev"
                              ? "Feature development instead"
                              : "Solution design instead"}
                        </button>
                      ))}
                    <button
                      onClick={() => {
                        markProposal(i, "answered in chat");
                        runAgentChat(m.proposal!.taskText, false);
                      }}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
                    >
                      Just ask the agent
                    </button>
                  </div>
                )}
              </div>
            ) : m.role === "changes" ? (
              <div key={i} className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-emerald-700">
                  Review - {m.text}
                </div>
                <div className="flex flex-col gap-1">
                  {m.changes?.map((c) => (
                    <button
                      key={c.file}
                      onClick={() => onOpenDiff?.(c.file)}
                      className="flex items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-emerald-100"
                      title="Open side-by-side diff"
                    >
                      <span
                        className={`w-14 shrink-0 text-[10px] font-semibold uppercase ${
                          c.status === "added"
                            ? "text-emerald-600"
                            : c.status === "deleted"
                              ? "text-red-500"
                              : "text-amber-600"
                        }`}
                      >
                        {c.status}
                      </span>
                      <span className="truncate font-mono">{c.file}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div key={i} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {m.text}
              </div>
            ),
          )}
        </div>
      </div>

      {/* composer */}
      <div className="border-t border-slate-200 bg-white p-4">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.rel}
                className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600"
              >
                <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 2h5l3 3v9H4z" strokeLinejoin="round" />
                  <path d="M9 2v3h3" strokeLinejoin="round" />
                </svg>
                {a.name}
                <button
                  onClick={() => setAttachments((x) => x.filter((y) => y.rel !== a.rel))}
                  className="text-slate-400 hover:text-slate-700"
                  title="Remove"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.doc,.txt,.log,.csv,.md"
            className="hidden"
            onChange={(e) => uploadFiles(e.target.files)}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading || running}
            className="flex h-9 w-9 shrink-0 items-center justify-center self-end rounded-full border border-slate-300 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-40"
            title="Add files - images, PDFs, or documents"
          >
            {uploading ? (
              <span className="text-xs">…</span>
            ) : (
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            )}
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder={
              current?.installed
                ? `Describe a task for ${current.label}… (Enter to send, Shift+Enter for newline)`
                : "Selected agent is not installed on this machine"
            }
            className="flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500"
          />
          <button
            onClick={send}
            disabled={running || !input.trim() || !current?.installed}
            className="self-end rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {running ? "Running…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
