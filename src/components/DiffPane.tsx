"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MONACO_OPTIONS, defineDhruvaTheme, PathCrumb } from "@/components/EditorPane";

const MonacoDiff = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
});

const LANG_BY_EXT: Record<string, string> = {
  cls: "java",
  trigger: "java",
  js: "javascript",
  ts: "typescript",
  json: "json",
  xml: "xml",
  html: "html",
  css: "css",
  md: "markdown",
};

export default function DiffPane({
  root,
  file,
  base,
  end,
}: {
  root: string;
  file: string;
  /** Pinned shadow-git commits of a historical run; unset = HEAD → current. */
  base?: string;
  end?: string;
}) {
  const [data, setData] = useState<{ before: string | null; after: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [stats, setStats] = useState<{ add: number; del: number } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diffRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/changes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root, file, base, end }),
        });
        const d = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(String(d.error ?? "could not load diff"));
        else setData(d);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, file, base, end]);

  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const lang = LANG_BY_EXT[ext] ?? "plaintext";

  if (error) return <p className="p-4 text-xs text-red-600">{error}</p>;
  if (!data) return <p className="p-4 text-xs text-slate-400">loading diff…</p>;

  const isNew = data.before === null;
  const isDeleted = data.after === null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-slate-200 bg-white px-4 py-2">
        <PathCrumb file={file} />
        {isNew && (
          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-semibold uppercase text-emerald-700">
            new file
          </span>
        )}
        {isDeleted && (
          <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[9px] font-semibold uppercase text-red-700">
            deleted
          </span>
        )}
        {stats && (stats.add > 0 || stats.del > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="font-semibold text-emerald-600">+{stats.add}</span>{" "}
            <span className="font-semibold text-red-500">−{stats.del}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1 text-[10px] text-slate-400 md:flex">
            <span className="rounded bg-red-50 px-1.5 py-px font-medium text-red-600">
              {base ? "run baseline" : "last snapshot"}
            </span>
            →
            <span className="rounded bg-emerald-50 px-1.5 py-px font-medium text-emerald-700">
              {end ? "run result" : "current"}
            </span>
          </span>
          <button
            onClick={() => setSideBySide((v) => !v)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-medium text-slate-500 hover:text-slate-800"
            title="Toggle split / inline diff"
          >
            {sideBySide ? "⫼ split" : "≡ inline"}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <MonacoDiff
          height="100%"
          language={lang}
          original={data.before ?? ""}
          modified={data.after ?? ""}
          onMount={(editor, monaco) => {
            diffRef.current = editor;
            defineDhruvaTheme(monaco);
            monaco.editor.setTheme("dhruva");
            // +N / -M counted from Monaco's own line changes - exact, zero cost
            editor.onDidUpdateDiff(() => {
              const changes = editor.getLineChanges() ?? [];
              let add = 0;
              let del = 0;
              for (const c of changes) {
                if (c.modifiedEndLineNumber >= c.modifiedStartLineNumber && c.modifiedEndLineNumber > 0)
                  add += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
                if (c.originalEndLineNumber >= c.originalStartLineNumber && c.originalEndLineNumber > 0)
                  del += c.originalEndLineNumber - c.originalStartLineNumber + 1;
              }
              setStats({ add, del });
            });
          }}
          options={{
            ...MONACO_OPTIONS,
            readOnly: true,
            renderSideBySide: sideBySide,
            renderOverviewRuler: false,
            diffWordWrap: "on",
          }}
        />
      </div>
    </div>
  );
}
