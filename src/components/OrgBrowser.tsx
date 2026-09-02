"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { groupTypes, OPEN_BY_DEFAULT, type GroupName } from "@/lib/orgGroups";

/** The org half of the project tree - the VS Code "Org Browser", in Dhruva.
 *
 * The local tree answers "what do I have?". This answers "what does the org
 * have?", which is a different and often more urgent question: on a brownfield
 * project the org is the source of truth and the local folder is a partial copy.
 * Expanding a type lists its members from the org; the download button on any
 * row retrieves just that row into the project.
 *
 * Everything here is read-only against the org. The only write is onto local
 * disk, by retrieve. */

interface MetaType {
  name: string;
  directoryName: string;
  inFolder: boolean;
  children: string[];
}

interface MetaMember {
  fullName: string;
  type: string;
  fileName?: string;
  lastModifiedByName?: string;
  lastModifiedDate?: string;
  manageableState?: string;
  namespacePrefix?: string;
}

type JobStatus = "queued" | "running" | "done" | "cancelled" | "failed";

interface Job {
  id: string;
  label: string;
  status: JobStatus;
  done: number;
  total: number;
  files: number;
  current: string;
  failed: { types: string[]; reason: string }[];
  skipped: string[];
  queuePosition: number;
}

function isActive(j: Job): boolean {
  return j.status === "queued" || j.status === "running";
}

/** Listings survive a remount, deliberately outliving the component.
 *
 * Listing one type on a real org is slow - ApexClass on a production org
 * measured 45 seconds. This panel used to be torn down and rebuilt whenever the
 * org badge flickered, and every one of those seconds was thrown away with it.
 * The mount condition is gone now, but the cost of being wrong here is high
 * enough to keep the results outside React's lifecycle regardless. Cleared by
 * the refresh button, which is the one action that means "ask the org again". */
const listings = new Map<string, MetaMember[]>(); // key: root, NUL, type

/** NUL, not a space: a project path may contain spaces, so a space
 * separator could let two different keys collide. */
const KEY_SEP = String.fromCharCode(0);

function listingKey(root: string, type: string): string {
  return root + KEY_SEP + type;
}

async function api<T>(body: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch("/api/org-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return res.ok ? (data as T) : null;
  } catch {
    return null;
  }
}

/** Download glyph - a tray with an arrow into it. Matches the tree's weight. */
function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 2v7m0 0L5.5 6.5M8 9l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v1.5A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V11" strokeLinecap="round" />
    </svg>
  );
}

function TypeNode({
  root,
  type,
  depth,
  runActive,
  onRetrieved,
  onStatus,
}: {
  root: string;
  type: MetaType;
  /** Nesting level inside the group, so indentation matches the local tree. */
  depth: number;
  /** A run holds the working tree - no downloads while it does. */
  runActive?: boolean;
  onRetrieved: () => void;
  onStatus: (s: string) => void;
}) {
  const cached = listings.get(listingKey(root, type.name)) ?? null;
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MetaMember[] | null>(cached);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open || members !== null) return;
    let cancelled = false;
    api<{ members: MetaMember[] }>({
      root,
      action: "members",
      type: type.name,
      inFolder: type.inFolder,
    }).then((d) => {
      const list = d?.members ?? [];
      // Stored even when this instance is gone: the next mount reads it back
      // rather than paying for the listing a second time.
      listings.set(listingKey(root, type.name), list);
      if (!cancelled) setMembers(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open, members, root, type.name, type.inFolder]);

  async function retrieve(spec: string, label: string) {
    setBusy(label);
    onStatus("Retrieving " + label + " ...");
    const res = await api<{ ok: boolean; output: string }>({
      root,
      action: "retrieve",
      specs: [spec],
    });
    setBusy(null);
    if (res?.ok) {
      onStatus(label + ": " + res.output);
      onRetrieved();
    } else {
      onStatus(label + " failed: " + (res?.output ?? "no response"));
    }
  }

  return (
    <div>
      <div className="group flex items-center rounded-md pr-1 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900">
        <button
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] text-left"
          style={{ paddingLeft: 6 + depth * 13 + "px" }}
          title={type.directoryName || type.name}
        >
          <span
            className={`inline-block w-3 shrink-0 text-center text-[11px] text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          <span className="truncate font-medium">{type.name}</span>
          {open && members === null && <span className="text-[11px] text-slate-400">…</span>}
          {members !== null && (
            <span className="shrink-0 text-[10px] text-slate-400">{members.length}</span>
          )}
        </button>
        <button
          onClick={() => retrieve(type.name, type.name)}
          disabled={busy !== null || runActive}
          className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-white hover:text-indigo-600 group-hover:opacity-100 disabled:opacity-40"
          title={"Retrieve all " + type.name + " into the project"}
        >
          {busy === type.name ? <span className="text-[10px]">…</span> : <DownloadIcon />}
        </button>
      </div>

      {open && members !== null && members.length === 0 && (
        <div
          className="py-[3px] text-[11px] italic text-slate-400"
          style={{ paddingLeft: 6 + (depth + 1) * 13 + "px" }}
        >
          nothing of this type in the org
        </div>
      )}

      {open && members !== null && members.length > 0 && (
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-slate-200/70"
            style={{ left: 11 + depth * 13 + "px" }}
          />
          {members.map((m) => {
            const spec = type.name + ":" + m.fullName;
            const managed = m.manageableState === "installed";
            return (
              <div
                key={spec}
                className="group flex items-center rounded-md pr-1 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                <div
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px]"
                  style={{ paddingLeft: 6 + (depth + 1) * 13 + "px" }}
                  title={
                    (m.fileName ?? spec) +
                    (m.lastModifiedByName
                      ? "\nlast changed by " +
                        m.lastModifiedByName +
                        (m.lastModifiedDate ? " on " + m.lastModifiedDate.slice(0, 10) : "")
                      : "")
                  }
                >
                  <span className="truncate">{m.fullName}</span>
                  {managed && (
                    <span className="shrink-0 rounded bg-slate-100 px-1 py-px text-[9px] font-semibold text-slate-500">
                      pkg
                    </span>
                  )}
                </div>
                <button
                  onClick={() => retrieve(spec, m.fullName)}
                  disabled={busy !== null || runActive}
                  className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-white hover:text-indigo-600 group-hover:opacity-100 disabled:opacity-40"
                  title={"Retrieve " + m.fullName + " into the project"}
                >
                  {busy === m.fullName ? <span className="text-[10px]">…</span> : <DownloadIcon />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function OrgBrowser({
  root,
  onRetrieved,
  runActive,
}: {
  root: string;
  /** Local files changed on disk - the local tree and editor should refresh. */
  onRetrieved: () => void;
  /** A workflow run holds the working tree. Downloads are paused: the server
   * refuses them too, this only explains why the buttons are dead. */
  runActive?: boolean;
}) {
  const [types, setTypes] = useState<MetaType[] | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");
  const [jobs, setJobs] = useState<Job[]>([]);
  // Bumped by the refresh button. The effect owns the fetch, so the state only
  // ever changes in a promise callback - never synchronously inside an effect.
  const [reload, setReload] = useState(0);
  const [openGroups, setOpenGroups] = useState<Set<GroupName>>(
    () => new Set(OPEN_BY_DEFAULT),
  );
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ types: MetaType[] }>({ root, action: "types", refresh: reload > 0 }).then((d) => {
      if (!cancelled) setTypes(d?.types ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [root, reload]);

  /** Reads the jobs without touching state, so callers decide what to do with
   * them. A retrieve outlives its own request, hence the polling. */
  const fetchJobs = useCallback(async (): Promise<Job[] | null> => {
    try {
      const res = await fetch("/api/org-metadata?root=" + encodeURIComponent(root));
      const data = await res.json();
      return Array.isArray(data?.jobs) ? (data.jobs as Job[]) : [];
    } catch {
      // a failed poll is UNKNOWN, not "no jobs": mapping it to [] made one
      // transient hiccup (a dev rebuild) read as "everything finished" - the
      // progress card vanished and polling stopped while the retrieve ran on
      return null;
    }
  }, [root]);

  const applyJobs = useCallback(
    (list: Job[] | null) => {
      if (list === null) return; // unknown - keep polling, keep the cards
      setJobs(list);
      // Polling stops only when nothing is queued or running. Files have landed
      // on disk by then, so the local tree is told to re-read.
      if (!list.some(isActive) && poll.current) {
        clearInterval(poll.current);
        poll.current = null;
        onRetrieved();
      }
    },
    [onRetrieved],
  );

  const startPolling = useCallback(() => {
    if (!poll.current) {
      poll.current = setInterval(() => {
        fetchJobs().then(applyJobs);
      }, 2000);
    }
  }, [fetchJobs, applyJobs]);

  // One read on mount, so a retrieve started before a reload still shows.
  useEffect(() => {
    let cancelled = false;
    fetchJobs().then((list) => {
      if (!cancelled) {
        applyJobs(list);
        if (list?.some(isActive)) startPolling();
      }
    });
    return () => {
      cancelled = true;
      if (poll.current) clearInterval(poll.current);
    };
  }, [fetchJobs, applyJobs, startPolling]);

  /** Queues a batched retrieve. No types means the whole org; a list means one
   * group of the tree - same job, same card, same partial-failure reporting,
   * because a group can hold twenty types and deserves batching too.
   *
   * Several can be queued at once and they run two at a time, so this never
   * refuses: the extras wait their turn and say so. */
  async function retrieveAll(types?: string[], label?: string) {
    setStatus("");
    const res = await api<{ id?: string }>({ root, action: "retrieve-all", types, label });
    if (!res?.id) {
      setStatus("could not queue the retrieve");
      return;
    }
    startPolling();
    applyJobs(await fetchJobs());
  }

  /** Stop is for a job in flight, close is for one that has finished. The
   * server refuses to close a running job, so a retrieve cannot be hidden from
   * the person who started it. */
  async function actOnJob(id: string, action: "cancel" | "dismiss") {
    await api({ root, action, id });
    if (action === "cancel") startPolling();
    applyJobs(await fetchJobs());
  }

  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0;
  const shown = (types ?? []).filter((t) =>
    !filtering
      ? true
      : t.name.toLowerCase().includes(needle) ||
        t.directoryName.toLowerCase().includes(needle),
  );
  const groups = groupTypes(shown);

  function toggleGroup(name: GroupName) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Buttons are no longer disabled just because something is running - queueing
  // several is the point. Only an exact repeat is blocked, so a double-click
  // cannot queue the same group twice.
  const activeLabels = new Set(jobs.filter(isActive).map((j) => j.label));
  const anyActive = activeLabels.size > 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter metadata types"
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none"
        />
        <button
          onClick={() => {
            // The refresh button is the one action that means "ask the org
            // again", so it drops the surviving listings too.
            for (const k of [...listings.keys()]) {
              if (k.startsWith(root + KEY_SEP)) listings.delete(k);
            }
            setTypes(null);
            setReload((n) => n + 1);
          }}
          className="shrink-0 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-500 hover:bg-slate-50 hover:text-slate-800"
          title="Re-read the org, ignoring the cached listing"
        >
          ↻
        </button>
      </div>

      {runActive && (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
          A workflow run is in progress. Downloads are paused so retrieved files
          are not counted as the run&apos;s own changes.
        </div>
      )}

      <button
        onClick={() => retrieveAll()}
        disabled={runActive || activeLabels.has("full org")}
        className="mb-2 w-full rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        title="Retrieve every metadata type the org lists, in batches"
      >
        {activeLabels.has("full org")
          ? "Retrieving full org…"
          : anyActive
            ? "Queue full org"
            : "Retrieve full org"}
      </button>

      {jobs.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {jobs.map((j) => {
            const active = isActive(j);
            const pct = j.total > 0 ? Math.round((j.done / j.total) * 100) : 0;
            const tone =
              j.status === "failed"
                ? "border-amber-200 bg-amber-50"
                : j.status === "cancelled"
                  ? "border-slate-200 bg-white"
                  : "border-slate-200 bg-slate-50";
            return (
              <div key={j.id} className={"rounded-lg border p-2 text-[11px] " + tone}>
                <div className="flex items-center gap-1.5 font-medium text-slate-600">
                  <span className="truncate">{j.label}</span>
                  {j.status === "queued" && (
                    <span className="shrink-0 rounded bg-slate-200 px-1 py-px text-[9px] font-semibold uppercase text-slate-600">
                      queued{j.queuePosition > 0 ? " " + j.queuePosition : ""}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 tabular-nums text-slate-400">
                    {j.files} files
                  </span>
                  {/* Stop while it runs, close once it has stopped - never both,
                      so the button always means one thing. */}
                  <button
                    onClick={() => actOnJob(j.id, active ? "cancel" : "dismiss")}
                    className="shrink-0 rounded px-1 text-slate-400 hover:bg-white hover:text-slate-800"
                    title={active ? "Stop after the current batch" : "Close this card"}
                  >
                    {active ? "stop" : "×"}
                  </button>
                </div>

                {j.status === "running" && j.total > 0 && (
                  <div className="mt-1 flex items-center gap-1.5 text-slate-500">
                    <span className="shrink-0 tabular-nums">
                      batch {Math.min(j.done + 1, j.total)}/{j.total}
                    </span>
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="h-full rounded-full bg-indigo-500 transition-all"
                        style={{ width: pct + "%" }}
                      />
                    </div>
                  </div>
                )}

                <div className="mt-1 truncate text-slate-400" title={j.current}>
                  {j.current}
                </div>

                {j.skipped.length > 0 && (
                  <div className="mt-1 text-slate-400">
                    {j.skipped.length} type(s) skipped - another retrieve is already pulling them
                  </div>
                )}

                {j.failed.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-amber-700">
                      {j.failed.length} batch(es) could not be retrieved
                    </summary>
                    <ul className="mt-1 space-y-1 text-slate-500">
                      {j.failed.map((f, i) => (
                        <li key={i}>
                          <span className="font-medium">{f.types.join(", ")}</span>
                          <div className="text-slate-400">{f.reason}</div>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}

      {status && (
        <div className="mb-2 truncate rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600" title={status}>
          {status}
        </div>
      )}

      {types === null && <div className="px-1.5 py-2 text-xs text-slate-400">Reading the org…</div>}

      {types !== null && types.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-[11px] text-slate-500">
          The org listed no metadata. Check that this project has an authorized org, and that the
          Salesforce CLI is installed.
        </div>
      )}

      {types !== null && types.length > 0 && shown.length === 0 && (
        <div className="px-1.5 py-2 text-[11px] text-slate-400">No type matches that filter.</div>
      )}

      {groups.map((g) => {
        // A filter is a search: showing the groups collapsed would hide the very
        // rows the user just asked for, so a filtered tree opens itself.
        const open = filtering || openGroups.has(g.name);
        return (
          <div key={g.name}>
            <div className="group flex items-center rounded-md pr-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-900">
              <button
                onClick={() => toggleGroup(g.name)}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] pl-1.5 text-left"
              >
                <span
                  className={`inline-block w-3 shrink-0 text-center text-[11px] text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
                <span className="truncate text-[10px] font-semibold uppercase tracking-wide">
                  {g.name}
                </span>
                <span className="shrink-0 text-[10px] text-slate-400">{g.types.length}</span>
              </button>
              <button
                onClick={() => retrieveAll(g.types.map((t) => t.name), g.name)}
                disabled={runActive || activeLabels.has(g.name)}
                className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-white hover:text-indigo-600 group-hover:opacity-100 disabled:opacity-40"
                title={"Retrieve every " + g.name + " type into the project (" + g.types.length + " types)"}
              >
                <DownloadIcon />
              </button>
            </div>
            {open && (
              <div className="relative">
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-0 top-0 left-[11px] w-px bg-slate-200/70"
                />
                {g.types.map((t) => (
                  <TypeNode
                    key={t.name}
                    root={root}
                    type={t}
                    depth={1}
                    runActive={runActive}
                    onRetrieved={onRetrieved}
                    onStatus={setStatus}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
