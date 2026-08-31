"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MONACO_OPTIONS, defineDhruvaTheme, PathCrumb } from "@/components/EditorPane";
import { Icon } from "@/components/icons";

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

export function langForDiff(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

/** +N / -M with a proportional bar - the shape of the change is readable
 * before the numbers are. Shared with the org compare view so a diff is
 * measured the same way whatever it is a diff against. */
export function DiffStat({ add, del }: { add: number; del: number }) {
  if (add === 0 && del === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`${add} added, ${del} removed`}>
      <span className="font-mono text-[11px] font-semibold text-emerald-600">+{add}</span>
      <span className="font-mono text-[11px] font-semibold text-red-500">-{del}</span>
      <span className="flex h-1.5 w-14 overflow-hidden rounded-full bg-slate-200">
        <span
          className="bg-emerald-500"
          style={{ width: `${(add / Math.max(1, add + del)) * 100}%` }}
        />
        <span className="bg-red-400" style={{ width: `${(del / Math.max(1, add + del)) * 100}%` }} />
      </span>
    </span>
  );
}

/** Segmented control - the current view is visibly selected rather than the
 * button naming the mode you are not in. */
export function ViewToggle({
  sideBySide,
  onChange,
}: {
  sideBySide: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center rounded-lg bg-slate-100 p-0.5">
      <button
        onClick={() => onChange(true)}
        aria-pressed={sideBySide}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
          sideBySide ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
        }`}
        title="Side by side"
      >
        <Icon.split size={12} strokeWidth={1.75} />
        Split
      </button>
      <button
        onClick={() => onChange(false)}
        aria-pressed={!sideBySide}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
          !sideBySide ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
        }`}
        title="Inline"
      >
        <Icon.inline size={12} strokeWidth={1.75} />
        Inline
      </button>
    </div>
  );
}

/** Count added/removed lines from Monaco's own line changes - exact, zero
 * cost. Shared so both diff views report the same numbers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function countDiffLines(editor: any): { add: number; del: number } {
  const changes = editor.getLineChanges() ?? [];
  let add = 0;
  let del = 0;
  for (const c of changes) {
    if (c.modifiedEndLineNumber >= c.modifiedStartLineNumber && c.modifiedEndLineNumber > 0)
      add += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
    if (c.originalEndLineNumber >= c.originalStartLineNumber && c.originalEndLineNumber > 0)
      del += c.originalEndLineNumber - c.originalStartLineNumber + 1;
  }
  return { add, del };
}

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

  const lang = langForDiff(file);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Icon.warn size={20} strokeWidth={1.75} className="text-red-400" />
        <p className="text-xs font-medium text-red-600">Could not load the diff</p>
        <p className="max-w-sm text-[11px] leading-relaxed text-slate-500">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-8">
        <Icon.running size={14} strokeWidth={1.75} className="animate-pulse text-slate-300" />
        <p className="text-xs text-slate-400">Loading diff…</p>
      </div>
    );
  }

  const isNew = data.before === null;
  const isDeleted = data.after === null;
  // Identical sides render as a blank diff, which reads as "broken" rather
  // than "nothing changed". Say which two states were compared, so the user
  // can tell an empty diff from a failed one.
  const identical = !isNew && !isDeleted && data.before === data.after;

  return (
    <div className="flex h-full flex-col">
      {/* header reads left to right as a sentence: which file, what happened
          to it, how much changed, and what it is being compared against */}
      <div className="flex items-center gap-2.5 border-b border-slate-200 bg-white px-4 py-2.5">
        <Icon.diff size={14} strokeWidth={1.75} className="shrink-0 text-slate-400" />
        <PathCrumb file={file} />

        {isNew && (
          <span className="shrink-0 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200">
            new
          </span>
        )}
        {isDeleted && (
          <span className="shrink-0 rounded-md bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 ring-1 ring-inset ring-red-200">
            deleted
          </span>
        )}

        {stats && <DiffStat add={stats.add} del={stats.del} />}

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-[11px] md:flex">
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">
              {base ? "run baseline" : "last snapshot"}
            </span>
            <Icon.chevron size={12} strokeWidth={2} className="text-slate-300" />
            <span className="rounded-md bg-slate-900 px-1.5 py-0.5 font-medium text-white">
              {end ? "run result" : "current"}
            </span>
          </span>

          <ViewToggle sideBySide={sideBySide} onChange={setSideBySide} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {identical ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Icon.ok size={20} strokeWidth={1.75} className="text-slate-300" />
            <p className="text-xs font-medium text-slate-600">No differences</p>
            <p className="max-w-sm text-[11px] leading-relaxed text-slate-500">
              {base
                ? "This file is identical between the run's baseline and its result."
                : "This file is identical to the last snapshot, so nothing has changed since."}
              {!base && (
                <>
                  {" "}
                  If you expected to see a historical run&apos;s changes, that run has no pinned
                  commits - only runs recorded after diff pinning was added can be replayed.
                </>
              )}
            </p>
          </div>
        ) : (
        <MonacoDiff
          height="100%"
          language={lang}
          original={data.before ?? ""}
          modified={data.after ?? ""}
          onMount={(editor, monaco) => {
            diffRef.current = editor;
            defineDhruvaTheme(monaco);
            monaco.editor.setTheme("dhruva");
            editor.onDidUpdateDiff(() => setStats(countDiffLines(editor)));
          }}
          options={{
            ...MONACO_OPTIONS,
            readOnly: true,
            renderSideBySide: sideBySide,
            renderOverviewRuler: false,
            // The +/- glyphs in the margin are the one part of a diff that is
            // readable no matter what the syntax colours are doing, so they
            // are asked for explicitly rather than left to the default.
            renderIndicators: true,
            // NOT diffWordWrap:"on". Monaco 0.56 applies viewport wrapping to the
            // MODIFIED editor only - measured: isViewportWrapping true on the
            // modified side, false on the original, with wordWrap:"on" and with
            // diffWordWrap:"inherit" alike. One side wrapping and the other not
            // makes Monaco insert diagonal alignment filler to keep the rows
            // level, and the result reads as a broken diff rather than a diff of
            // long lines. Off on both sides is aligned, and is what VS Code's own
            // diff does: long lines scroll horizontally, in sync.
            diffWordWrap: "off",
          }}
        />
        )}
      </div>
    </div>
  );
}
