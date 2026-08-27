"use client";

import { useEffect, useRef, useState } from "react";

interface Entry {
  name: string;
  type: "dir" | "file";
}

/** File badges: a tinted letter tile per type - reads like an IDE, not a chat. */
const FILE_BADGES: Record<string, { l: string; c: string }> = {
  cls: { l: "A", c: "bg-sky-100 text-sky-700" },
  trigger: { l: "T", c: "bg-amber-100 text-amber-700" },
  js: { l: "J", c: "bg-yellow-100 text-yellow-700" },
  ts: { l: "TS", c: "bg-sky-100 text-sky-700" },
  html: { l: "<>", c: "bg-orange-100 text-orange-700" },
  css: { l: "#", c: "bg-violet-100 text-violet-700" },
  xml: { l: "X", c: "bg-slate-100 text-slate-500" },
  json: { l: "{}", c: "bg-slate-100 text-slate-500" },
  md: { l: "M", c: "bg-indigo-100 text-indigo-700" },
  soql: { l: "Q", c: "bg-emerald-100 text-emerald-700" },
  txt: { l: "≡", c: "bg-slate-100 text-slate-400" },
  log: { l: "≡", c: "bg-slate-100 text-slate-400" },
};

/** Salesforce metadata folders get a typed chip so the tree explains the org. */
const DIR_CHIPS: Record<string, { chip: string; c: string }> = {
  classes: { chip: "Apex", c: "bg-sky-100 text-sky-700" },
  triggers: { chip: "Triggers", c: "bg-amber-100 text-amber-700" },
  lwc: { chip: "LWC", c: "bg-indigo-100 text-indigo-700" },
  aura: { chip: "Aura", c: "bg-violet-100 text-violet-700" },
  objects: { chip: "Objects", c: "bg-emerald-100 text-emerald-700" },
  flows: { chip: "Flows", c: "bg-fuchsia-100 text-fuchsia-700" },
  permissionsets: { chip: "Perms", c: "bg-rose-100 text-rose-700" },
  profiles: { chip: "Profiles", c: "bg-rose-100 text-rose-700" },
  layouts: { chip: "Layouts", c: "bg-slate-100 text-slate-500" },
  flexipages: { chip: "Pages", c: "bg-slate-100 text-slate-500" },
  staticresources: { chip: "Static", c: "bg-slate-100 text-slate-500" },
};

function FileBadge({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const b = FILE_BADGES[ext] ?? { l: "·", c: "bg-slate-100 text-slate-400" };
  return (
    <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-[5px] text-[7.5px] font-bold ${b.c}`}>
      {b.l}
    </span>
  );
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

  // Children load whenever the node is open and not yet loaded - this also
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

  const dirChip = entry.type === "dir" ? DIR_CHIPS[entry.name.toLowerCase()] : undefined;

  return (
    <div className="relative">
      <button
        onClick={toggle}
        className={`group flex w-full items-center gap-1.5 rounded-md px-1.5 py-[3px] text-left text-xs transition-colors ${
          isSelected
            ? "bg-indigo-50 font-medium text-indigo-900 shadow-[inset_2px_0_0_#6366f1]"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
        style={{ paddingLeft: `${6 + depth * 13}px` }}
        title={rel}
      >
        {entry.type === "dir" ? (
          <span
            className={`inline-block w-3 shrink-0 text-center text-[9px] text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
          >
            ▶
          </span>
        ) : (
          <FileBadge name={entry.name} />
        )}
        <span className={`truncate ${entry.type === "dir" ? "font-medium" : ""}`}>{entry.name}</span>
        {dirChip && (
          <span className={`ml-auto rounded px-1 py-px text-[8px] font-semibold ${dirChip.c}`}>
            {dirChip.chip}
          </span>
        )}
        {open && children === null && (
          <span className="ml-auto text-[10px] text-slate-400">…</span>
        )}
      </button>
      {open && children && children.length > 0 && (
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-slate-200/70"
            style={{ left: `${11 + depth * 13}px` }}
          />
          {children.map((c) => (
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
      )}
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
  /** The project's default package directory (e.g. "force-app") - expanded
   * on load along with its main/default chain. */
  defaultDir?: string;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryRef = useRef("");

  // Remounted per project (key={root}) - the effect only loads.
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
    queryRef.current = q;
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
        // a slow response for an older query must not overwrite newer results
        if (queryRef.current !== q) return;
        setResults(res.ok ? (data.results as string[]) : []);
      } catch {
        if (queryRef.current === q) setResults([]);
      } finally {
        if (queryRef.current === q) setSearching(false);
      }
    }, 250);
  }

  // clear any pending debounce on unmount
  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

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
                <FileBadge name={r.split("/").pop() ?? r} />
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
