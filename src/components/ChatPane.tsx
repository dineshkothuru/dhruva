"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents";

interface Msg {
  role: "user" | "agent" | "system";
  agent?: AgentId;
  text: string;
}

interface AgentStatus {
  label: string;
  installed: boolean;
  version?: string;
  installHint: string;
  models: { id: string; label: string }[];
}

const AGENT_ORDER: AgentId[] = ["copilot", "claude", "codex"];

export default function ChatPane({ root }: { root: string }) {
  const [status, setStatus] = useState<Record<string, AgentStatus> | null>(null);
  const [agent, setAgent] = useState<AgentId>("copilot");
  // model per agent, so switching agents remembers each one's choice
  const [models, setModels] = useState<Partial<Record<AgentId, string>>>({});
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  }, [messages]);

  async function send() {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput("");
    setRunning(true);
    setMessages((m) => [...m, { role: "user", text: prompt }, { role: "agent", agent, text: "" }]);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root,
          agent,
          prompt,
          model: models[agent] ?? status?.[agent]?.models?.[0]?.id ?? "",
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text();
        setMessages((m) => [...m, { role: "system", text: err || `HTTP ${res.status}` }]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          if (last?.role === "agent") next[next.length - 1] = { ...last, text: last.text + chunk };
          return next;
        });
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "system", text: String(e) }]);
    } finally {
      setRunning(false);
    }
  }

  const current = status?.[agent];

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
              disabled={running}
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
          <select
            value={models[agent] ?? current.models[0].id}
            onChange={(e) => setModels((m) => ({ ...m, [agent]: e.target.value }))}
            disabled={running}
            className="ml-auto rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 outline-none focus:border-slate-400 disabled:opacity-50"
            title="Model the agent runs with — pick one your org's policy allows"
          >
            {current.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
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
                Describe a task — the selected agent works inside the attached project and its
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
        <div className="flex gap-2">
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
