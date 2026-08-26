"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <span className="truncate font-mono text-xs text-slate-600">{file}</span>
        <span className="ml-auto text-[11px] text-slate-400">
          {base
            ? `run baseline → ${end ? "run result" : "current"}`
            : "before (last snapshot) → after (current)"}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <MonacoDiff
          height="100%"
          language={lang}
          original={data.before ?? ""}
          modified={data.after ?? ""}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            fontSize: 13,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
