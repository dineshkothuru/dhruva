"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { FileBadge } from "@/components/FileTree";
import { Icon } from "@/components/icons";
import { bindModelFile, registerLspCompletions } from "@/components/monacoLsp";

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


/** One Monaco look for the whole app - quiet light theme, real code font. */
export const MONACO_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  fontLigatures: true,
  lineHeight: 21,
  padding: { top: 12, bottom: 12 },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  smoothScrolling: true,
  cursorBlinking: "smooth" as const,
  renderLineHighlight: "all" as const,
  guides: { indentation: true, bracketPairs: true },
  bracketPairColorization: { enabled: true },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineDhruvaTheme(monaco: any) {
  monaco.editor.defineTheme("dhruva", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.lineHighlightBackground": "#f8fafc",
      "editorLineNumber.foreground": "#cbd5e1",
      "editorLineNumber.activeForeground": "#64748b",
      "editorIndentGuide.background1": "#f1f5f9",
      "editorIndentGuide.activeBackground1": "#e2e8f0",
      "editor.selectionBackground": "#e0e7ff",
      "editorCursor.foreground": "#4f46e5",
      // Diff colours, and the reason they are not paler.
      //
      // These were #fef2f2 at 40% alpha for a removed line and #fee2e2 at 27%
      // for removed words - which over white is very nearly white. On an Apex
      // or LWC file that is unreadable, because the SYNTAX already paints
      // attribute values and strings red: a 27%-alpha pink behind red text
      // does not say "removed", it just says "code". The block colour has to
      // win against the token colours, not blend into them.
      //
      // So: a flat line wash strong enough to read as a band, plus a much
      // stronger WORD-level wash on top of it, which is what makes the exact
      // characters that changed findable inside a changed line. The values are
      // GitHub's light diff palette, which is heavily proven on red-and-green
      // syntax.
      "diffEditor.insertedLineBackground": "#e6ffecff",
      "diffEditor.removedLineBackground": "#ffebe9ff",
      "diffEditor.insertedTextBackground": "#abf2bc88",
      "diffEditor.removedTextBackground": "#ffcecb99",
      // The gutter strip carries the same signal at full strength, so the
      // change is still locatable when the line wash is behind dense syntax.
      "diffEditorGutter.insertedLineBackground": "#abf2bc66",
      "diffEditorGutter.removedLineBackground": "#ffcecb66",
      // The hatched filler Monaco draws where one side has no matching lines.
      // Kept quiet: it is scaffolding, not content.
      "diffEditor.diagonalFill": "#e2e8f0",
      "diffEditorOverview.insertedForeground": "#22c55e",
      "diffEditorOverview.removedForeground": "#ef4444",
    },
  });
}

/** Breadcrumb path: dim segments, chevrons, bold filename with type badge. */
export function PathCrumb({ file }: { file: string }) {
  const parts = file.split("/");
  const name = parts.pop() ?? file;
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono text-xs">
      {parts.map((p, i) => (
        <span key={i} className="flex shrink items-center gap-1 truncate text-slate-400">
          <span className="truncate">{p}</span>
          <span className="text-slate-300">/</span>
        </span>
      ))}
      <FileBadge name={name} />
      <span className="truncate font-semibold text-slate-800">{name}</span>
    </span>
  );
}

function langFor(file: string) {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

export default function EditorPane({
  root,
  file,
  onCompareOrg,
  onPushToOrg,
}: {
  root: string;
  file: string;
  /** Opens the org compare view for this file in its own tab. */
  onCompareOrg?: (file: string) => void;
  /** Opens the push-to-org confirmation for this file. */
  onPushToOrg?: (file: string) => void;
}) {
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
  // starts fresh - the effect only loads the content.
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
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <PathCrumb file={file} />
        <span className="hidden shrink-0 rounded-md bg-slate-100 px-1.5 py-px text-[11px] font-semibold uppercase text-slate-400 sm:inline">
          {lang}
        </span>
        {content !== null && (
          <span className="hidden shrink-0 text-[11px] text-slate-300 md:inline">
            {content.split("\n").length} lines
          </span>
        )}
        {dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" title="unsaved changes (Ctrl+S to save)" />}
        <div className="ml-auto flex items-center gap-2">
          {savedAt && !dirty && <span className="text-[11px] text-emerald-600">saved</span>}
          {/* Compare comes BEFORE retrieve, in both position and intent:
              retrieve overwrites this file with the org's copy, and comparing
              is how you find out whether you want that. It is not gated on the
              path the way retrieve is - a project whose package directory is
              not "force-app" still needs it, and the compare API answers
              "not metadata" clearly for anything that is not. */}
          {onCompareOrg && (
            <button
              onClick={() => onCompareOrg(file)}
              disabled={dirty || content === null}
              className="flex items-center gap-1.5 rounded-lg border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 disabled:opacity-40"
              title={
                dirty
                  ? "Save or discard your edits first - the compare reads what is on disk"
                  : "Diff this file against the connected org, and pull changes back block by block"
              }
            >
              <Icon.diff size={13} strokeWidth={1.75} />
              Compare with org
            </button>
          )}
          {/* Push sits AFTER retrieve, and is the only button here that writes
              to the org. Disabled while the buffer is dirty for a concrete
              reason: sf deploys what is on DISK, so an unsaved edit would be
              silently left behind and the user would believe it shipped. */}
          {onPushToOrg && (
            <button
              onClick={() => onPushToOrg(file)}
              disabled={dirty || content === null}
              className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-40"
              title={
                dirty
                  ? "Save first - a deploy sends what is on disk, so unsaved edits would be left behind"
                  : "Deploy this component to the connected org (asks for confirmation, and can validate first)"
              }
            >
              <Icon.deployUp size={13} strokeWidth={1.75} />
              Push to org
            </button>
          )}
          {file.startsWith("force-app") && (
            <button
              onClick={retrieveFromOrg}
              disabled={retrieving || dirty || content === null}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
              title={
                dirty
                  ? "Save or discard your edits first - retrieving would overwrite them"
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
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              defineDhruvaTheme(monaco);
              monaco.editor.setTheme("dhruva");
              // Registration is global and guarded; the binding is per model,
              // and is what lets the provider know this buffer is (say) an LWC
              // template rather than an unrelated .html.
              registerLspCompletions(monaco);
              bindModelFile(editor.getModel(), root, file);
              // Ctrl/Cmd+S saves - muscle memory must work
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
            }}
            options={{ ...MONACO_OPTIONS, formatOnPaste: true, formatOnType: true }}
          />
        )}
      </div>
    </div>
  );
}
