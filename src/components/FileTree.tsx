"use client";

import { useEffect, useRef, useState } from "react";

interface Entry {
  name: string;
  type: "dir" | "file";
}

const FILE_ICONS: Record<string, string> = {
  cls: "🟦",
  trigger: "⚡",
  js: "🟨",
  ts: "🟦",
  html: "🌐",
  css: "🎨",
  xml: "📄",
  json: "🧾",
  md: "📘",
  apex: "🟦",
  soql: "🔍",
};

function iconFor(name: string, type: Entry["type"], open: boolean) {
  if (type === "dir") return open ? "📂" : "📁";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_ICONS[ext] ?? "📄";
}

async function listDir(root: string, dir: string): Promise<Entry[]> {
  try {
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, dir }),
    });
    const data = await res.json();
    return res.ok ? (data.entries as Entry[]) : [];
  } catch {
    return [];
  }
}

function Node({
  root,
  rel,
  entry,
  depth,
  onOpenFile,
  selected,
  autoOpenPath,
}: {
  root: string;
  rel: string;
  entry: Entry;
  depth: number;
  onOpenFile: (rel: string) => void;
  selected: string | null;
  /** Chain of directory rels to expand automatically (e.g. the default package dir). */
  autoOpenPath: string[];
}) {
  const [open, setOpen] = useState(entry.type === "dir" && autoOpenPath.includes(rel));
  const [children, setChildren] = useState<Entry[] | null>(null);

  // Children load whenever the node is open and not yet loaded — this also
  // powers the auto-expanded chain on first render.
  useEffect(() => {
    if (!open || children !== null) return;
    let cancelled = false;
    listDir(root, rel).then((entries) => {
      if (!cancelled) setChildren(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [open, children, root, rel]);

  function toggle() {
    if (entry.type === "file") onOpenFile(rel);
    else setOpen(!open);
  }

  const isSelected = entry.type === "file" && selected === rel;

  return (
    <div>
      <button
        onClick={toggle}
        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-xs hover:bg-slate-100 ${
          isSelected ? "bg-slate-200 font-medium" : ""
        }`}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        title={rel}
      >
        <span className="shrink-0 text-[11px]">{iconFor(entry.name, entry.type, open)}</span>
        <span className="truncate">{entry.name}</span>
        {open && children === null && (
          <span className="ml-auto text-[10px] text-slate-400">…</span>
        )}
      </button>
      {open &&
        children?.map((c) => (
          <Node
            key={c.name}
            root={root}
            rel={rel ? `${rel}/${c.name}` : c.name}
            entry={c}
            depth={depth + 1}
            onOpenFile={onOpenFile}
            selected={selected}
            autoOpenPath={autoOpenPath}
          />
        ))}
    </div>
  );
}

export default function FileTree({
  root,
  onOpenFile,
  selected,
  defaultDir,
}: {
  root: string;
  onOpenFile: (rel: string) => void;
  selected: string | null;
  /** The project's default package directory (e.g. "force-app") — expanded
   * on load along with its main/default chain. */
  defaultDir?: string;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Remounted per project (key={root}) — the effect only loads.
  useEffect(() => {
    let cancelled = false;
    listDir(root, "").then((e) => {
      if (!cancelled) setEntries(e);
    });
    return () => {
      cancelled = true;
    };
  }, [root]);

  function onQueryChange(q: string) {
    setQuery(q);
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root, q }),
        });
        const data = await res.json();
        setResults(res.ok ? (data.results as string[]) : []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  }

  const norm = (defaultDir ?? "force-app").replace(/\\/g, "/").replace(/\/+$/, "");
  const autoOpenPath = [norm, `${norm}/main`, `${norm}/main/default`];

  return (
    <div className="pb-4">
      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search files…"
        spellCheck={false}
        className="mb-2 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
      />

      {query.trim().length >= 2 ? (
        searching && results === null ? (
          <p className="px-2 py-1 text-xs text-slate-400">searching…</p>
        ) : results && results.length > 0 ? (
          <div>
            {results.map((r) => (
              <button
                key={r}
                onClick={() => onOpenFile(r)}
                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-xs hover:bg-slate-100 ${
                  selected === r ? "bg-slate-200 font-medium" : ""
                }`}
                title={r}
              >
                <span className="shrink-0 text-[11px]">
                  {iconFor(r.split("/").pop() ?? r, "file", false)}
                </span>
                <span className="truncate font-medium">{r.split("/").pop()}</span>
                <span className="ml-1 truncate text-[10px] text-slate-400">
                  {r.split("/").slice(0, -1).join("/")}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-slate-400">no files match</p>
        )
      ) : entries === null ? (
        <p className="px-2 py-1 text-xs text-slate-400">loading files…</p>
      ) : (
        entries.map((e) => (
          <Node
            key={e.name}
            root={root}
            rel={e.name}
            entry={e}
            depth={0}
            onOpenFile={onOpenFile}
            selected={selected}
            autoOpenPath={autoOpenPath}
          />
        ))
      )}
    </div>
  );
}
