"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const Monaco = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const LANG_BY_EXT: Record<string, string> = {
  cls: "java", // closest highlighting Monaco ships for Apex
  trigger: "java",
  apex: "java",
  js: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  json: "json",
  xml: "xml",
  html: "html",
  cmp: "html",
  css: "css",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  soql: "sql",
  sql: "sql",
};

function langFor(file: string) {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

export default function EditorPane({ root, file }: { root: string; file: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [retrieving, setRetrieving] = useState(false);

  async function reloadFromDisk() {
    const res = await fetch("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, file, action: "read" }),
    });
    const data = await res.json();
    if (res.ok) {
      setContent(String(data.content));
      setOriginal(String(data.content));
    }
  }

  /** VS Code parity: pull this one file fresh from the connected org. */
  async function retrieveFromOrg() {
    if (retrieving) return;
    setRetrieving(true);
    setError(null);
    try {
      const res = await fetch("/api/retrieve-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, file }),
      });
      const data = await res.json();
      if (!res.ok) setError(String(data.error ?? "retrieve failed"));
      else {
        await reloadFromDisk();
        setSavedAt(Date.now());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRetrieving(false);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  const lang = langFor(file);
  // Monaco ships formatters for these; Apex (java-highlighted) has none.
  const canFormat = ["json", "html", "css", "javascript", "typescript"].includes(lang);

  function format() {
    editorRef.current?.getAction("editor.action.formatDocument")?.run();
  }

  // The parent remounts this component per file (key={file}), so state
  // starts fresh — the effect only loads the content.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root, file, action: "read" }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(String(data.error ?? "could not read file"));
        else {
          setContent(String(data.content));
          setOriginal(String(data.content));
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, file]);

  async function save() {
    if (content === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, file, action: "write", content }),
      });
      const data = await res.json();
      if (!res.ok) setError(String(data.error ?? "could not save"));
      else {
        setOriginal(content);
        setSavedAt(Date.now());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = content !== null && content !== original;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <span className="truncate font-mono text-xs text-slate-600">{file}</span>
        {dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" title="unsaved changes" />}
        <div className="ml-auto flex items-center gap-2">
          {savedAt && !dirty && <span className="text-[11px] text-emerald-600">saved</span>}
          {file.startsWith("force-app") && (
            <button
              onClick={retrieveFromOrg}
              disabled={retrieving || dirty || content === null}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
              title={
                dirty
                  ? "Save or discard your edits first — retrieving would overwrite them"
                  : "Pull this file fresh from the connected org (overwrites the local copy)"
              }
            >
              {retrieving ? "Retrieving…" : "↓ Retrieve from org"}
            </button>
          )}
          {error && <span className="max-w-xs truncate text-[11px] text-red-600">{error}</span>}
          {canFormat && (
            <button
              onClick={format}
              disabled={content === null}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
              title="Format document (Monaco built-in formatter)"
            >
              Format
            </button>
          )}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {content === null && !error ? (
          <p className="p-4 text-xs text-slate-400">loading…</p>
        ) : error && content === null ? (
          <p className="p-4 text-xs text-red-600">{error}</p>
        ) : (
          <Monaco
            height="100%"
            language={lang}
            value={content ?? ""}
            onChange={(v) => setContent(v ?? "")}
            onMount={(editor) => {
              editorRef.current = editor;
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              formatOnPaste: true,
              formatOnType: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
