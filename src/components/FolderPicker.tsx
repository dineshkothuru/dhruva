"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

/** Modal folder picker backed by /api/browse - navigates the local machine's
 * drives so users never type a path by hand. */
export default function FolderPicker({
  initialDir,
  onPick,
  onCancel,
}: {
  initialDir?: string;
  onPick: (dir: string) => void;
  onCancel: () => void;
}) {
  const [dir, setDir] = useState<string>("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<string[]>([]);
  const [isProject, setIsProject] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(target: string) {
    try {
      const res = await fetch("/api/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        // an unusable start path must never strand the picker - fall back to
        // the drive list, like a native Open dialog
        if (target !== "") {
          await load("");
          return;
        }
        setError(String(data.error ?? "cannot open"));
        return;
      }
      setError(null);
      setDir(String(data.dir ?? ""));
      setParent(data.parent === null ? null : String(data.parent));
      setEntries((data.entries as string[]) ?? []);
      setIsProject(data.isProject === true);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    // async load on mount - state set only after the fetch resolves
    void load(initialDir ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const join = (name: string) =>
    dir === "" ? name : dir.endsWith("\\") || dir.endsWith("/") ? `${dir}${name}` : `${dir}\\${name}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-6"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="mt-10 flex max-h-[70vh] w-full max-w-lg flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Choose a project folder</h3>
          <button onClick={onCancel} className="ml-auto rounded-md px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Icon.close size={12} strokeWidth={2.25} /></button>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => parent !== null && load(parent)}
            disabled={parent === null}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-30"
            title="Up one level"
          >
            ↑ Up
          </button>
          <span className="min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-2 py-1 font-mono text-xs text-slate-600" title={dir || "Drives"}>
            {dir || "Drives"}
          </span>
        </div>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-100">
          {entries.map((name) => (
            <button
              key={name}
              onClick={() => load(dir === "" ? name : join(name))}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50"
            >
              <Icon.folder size={12} strokeWidth={1.75} className="shrink-0 text-slate-400" /> <span className="truncate">{name}</span>
            </button>
          ))}
          {entries.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">no subfolders</p>}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {isProject && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              Salesforce project
            </span>
          )}
          <button
            onClick={() => dir && onPick(dir)}
            disabled={!dir}
            className="ml-auto rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
