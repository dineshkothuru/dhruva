"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";

/** "New component" - the dialog behind the + in the file tree header.
 *
 * The one design decision worth stating: there is NO FOLDER PICKER. A metadata
 * type determines its own directory - a class goes in classes, an LWC in lwc -
 * so asking the user where to put it is asking them to repeat something already
 * known, and giving them the chance to get it wrong. The destination is
 * computed and shown read-only instead, and the only choice offered is the
 * package directory, and only when the project actually has more than one. */

interface TypeInfo {
  id: string;
  label: string;
  group: string;
  dir: string;
  templates: string[];
  needs: string[];
  nameStyle: "pascal" | "camel";
}

const TRIGGER_EVENTS = [
  "before insert",
  "before update",
  "before delete",
  "after insert",
  "after update",
  "after delete",
  "after undelete",
];

const MIME_TYPES = [
  "application/zip",
  "application/json",
  "text/javascript",
  "text/css",
  "text/plain",
  "image/png",
  "image/svg+xml",
];

/** Mirrors STATIC_RESOURCE_EXT on the server, so the dialog can name the file
 * it is about to create. Kept in sync by a test that compares the two. */
const MIME_EXT: Record<string, string | null> = {
  "application/zip": null,
  "application/json": "json",
  "text/javascript": "js",
  "text/css": "css",
  "text/plain": "txt",
  "image/png": "resource",
  "image/svg+xml": "resource",
};

const GROUP_ORDER = ["Apex", "Lightning", "Visualforce", "Other"];

export default function NewMetadataDialog({
  root,
  onClose,
  onCreated,
}: {
  root: string;
  onClose: () => void;
  /** Called with the file worth opening, plus every file that was written. */
  onCreated: (primary: string | undefined, created: string[]) => void;
}) {
  const [types, setTypes] = useState<TypeInfo[] | null>(null);
  const [pkgDirs, setPkgDirs] = useState<string[]>([]);
  const [typeId, setTypeId] = useState("apex-class");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [sobject, setSobject] = useState("");
  const [events, setEvents] = useState<string[]>(["before insert"]);
  const [label, setLabel] = useState("");
  const [mime, setMime] = useState(MIME_TYPES[0]);
  const [pkg, setPkg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/create-metadata?root=${encodeURIComponent(root)}`);
        const d = await res.json();
        if (cancelled) return;
        setTypes(d.types as TypeInfo[]);
        setPkgDirs((d.packageDirs as string[]) ?? []);
        setPkg(((d.packageDirs as string[]) ?? [])[0] ?? "");
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root]);

  const type = useMemo(() => types?.find((t) => t.id === typeId) ?? null, [types, typeId]);

  // The template is DERIVED rather than synced in an effect: `template` holds
  // only an explicit choice, and an empty one means "this type's default".
  // Syncing it on type change instead left a stale template selected for one
  // render - long enough to submit an Apex template against an LWC.
  const effTemplate = template || type?.templates[0] || "";

  useEffect(() => {
    nameRef.current?.focus();
  }, [types]);

  const grouped = useMemo(() => {
    const out: { group: string; items: TypeInfo[] }[] = [];
    for (const g of GROUP_ORDER) {
      const items = (types ?? []).filter((t) => t.group === g);
      if (items.length) out.push({ group: g, items });
    }
    return out;
  }, [types]);

  const destination = type && pkg ? `${pkg}/main/default/${type.dir}` : "";

  // Mirrors the server's rule so the user is told before a round trip, not
  // after one. The server still validates - this is courtesy, not security.
  const nameOk =
    type === null
      ? false
      : type.nameStyle === "camel"
        ? /^[a-z][A-Za-z0-9_]{0,79}$/.test(name)
        : /^[A-Z][A-Za-z0-9_]{0,79}$/.test(name);

  const ready =
    !!type &&
    nameOk &&
    !busy &&
    (!type.needs.includes("sobject") || /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(sobject.trim())) &&
    (!type.needs.includes("events") || events.length > 0) &&
    (!type.needs.includes("label") || label.trim().length > 0);

  async function submit() {
    if (!ready || !type) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/create-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root,
          type: type.id,
          name,
          template: type.templates.length ? effTemplate : undefined,
          sobject: type.needs.includes("sobject") ? sobject.trim() : undefined,
          events: type.needs.includes("events") ? events : undefined,
          label: type.needs.includes("label") ? label.trim() : undefined,
          mime: type.needs.includes("mime") ? mime : undefined,
          packageDir: pkg || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) setError(String(d.error ?? "could not create"));
      else {
        onCreated(d.primary as string | undefined, (d.created as string[]) ?? []);
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 p-6 pt-[8vh]"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800">New component</h2>
          <button
            onClick={onClose}
            className="ml-auto rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title="Close (Esc)"
          >
            <Icon.close size={14} strokeWidth={2.25} />
          </button>
        </div>

        <div className="flex flex-col gap-3.5 px-5 py-4">
          {types === null ? (
            <p className="py-6 text-center text-xs text-slate-400">loading templates…</p>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Type
                </span>
                <select
                  value={typeId}
                  onChange={(e) => {
                    setTypeId(e.target.value);
                    setTemplate("");
                    setError(null);
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-slate-500"
                >
                  {grouped.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Name
                </span>
                <input
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                  spellCheck={false}
                  placeholder={type?.nameStyle === "camel" ? "myComponent" : "AccountService"}
                  className={`rounded-lg border bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-slate-500 ${
                    name && !nameOk ? "border-red-300" : "border-slate-300"
                  }`}
                />
                {name && !nameOk && (
                  <span className="text-[11px] text-red-600">
                    {type?.nameStyle === "camel"
                      ? "Start with a lowercase letter, then letters, digits or underscores."
                      : "Start with an uppercase letter, then letters, digits or underscores."}
                  </span>
                )}
              </label>

              {type && type.templates.length > 1 && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Template
                  </span>
                  <select
                    value={effTemplate}
                    onChange={(e) => setTemplate(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-slate-500"
                  >
                    {type.templates.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {type?.needs.includes("sobject") && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Object
                  </span>
                  <input
                    value={sobject}
                    onChange={(e) => setSobject(e.target.value)}
                    spellCheck={false}
                    placeholder="Account"
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
                  />
                </label>
              )}

              {type?.needs.includes("events") && (
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Events
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {TRIGGER_EVENTS.map((ev) => {
                      const on = events.includes(ev);
                      return (
                        <button
                          key={ev}
                          onClick={() =>
                            setEvents((cur) =>
                              cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev],
                            )
                          }
                          aria-pressed={on}
                          className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition ${
                            on
                              ? "bg-slate-900 text-white"
                              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                          }`}
                        >
                          {ev}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {type?.needs.includes("label") && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Label
                  </span>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Account Summary"
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-slate-500"
                  />
                </label>
              )}

              {type?.needs.includes("mime") && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Content type
                  </span>
                  <select
                    value={mime}
                    onChange={(e) => setMime(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
                  >
                    {MIME_TYPES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  {/* Answers "where is my file?" before it gets asked: a zip
                      resource is the one content type that produces a FOLDER
                      to drop files into rather than a file to edit. */}
                  <span className="text-[11px] text-slate-400">
                    {mime === "application/zip" ? (
                      <>
                        Creates a <span className="font-semibold text-slate-500">folder</span> to
                        drop your files into — everything inside is zipped on deploy.
                      </>
                    ) : (
                      <>
                        Creates{" "}
                        <span className="font-mono text-slate-500">
                          {name || "Name"}.{MIME_EXT[mime] ?? "resource"}
                        </span>{" "}
                        alongside its metadata, and opens it.
                      </>
                    )}
                  </span>
                </label>
              )}

              {/* Only a real choice when the project has one to make. */}
              {pkgDirs.length > 1 && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Package directory
                  </span>
                  <select
                    value={pkg}
                    onChange={(e) => setPkg(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
                  >
                    {pkgDirs.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Destination
                </span>
                <p className="truncate font-mono text-[11px] text-slate-600" title={destination}>
                  {destination || "—"}
                  {name && nameOk && <span className="text-slate-400">/{name}…</span>}
                </p>
              </div>

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700 ring-1 ring-inset ring-red-100">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <p className="text-[11px] text-slate-400">Creates local files only — nothing is deployed.</p>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={!ready}
              className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
