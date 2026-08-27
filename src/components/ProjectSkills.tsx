"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Project skills — per-project knowledge (.sfharness/skills/*.md) with a
 * read-only browser of the SHIPPED standards library alongside, so authors
 * see what is already covered instead of duplicating it into skills. */

interface SkillMeta {
  name: string;
  chars: number;
  mtime: number;
  truncated: boolean;
}

const COVERED_HINT =
  "Already covered by the team standards: Apex (classes, triggers, async, tests), LWC, flows, " +
  "security & FLS, naming, logging, metadata, deployments. Write only what is TRUE OF THIS ORG " +
  "and not derivable from code — conventions, landmines, org facts.";

export default function ProjectSkills({
  root,
  onOpenFile,
}: {
  root: string;
  /** Open a project-relative file in the built-in editor. */
  onOpenFile?: (rel: string) => void;
}) {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [injected, setInjected] = useState(0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [lib, setLib] = useState<{
    baseline: { chars: number; body: string };
    modules: { name: string; body: string }[];
    personas: { name: string; body: string }[];
  } | null>(null);
  const [viewing, setViewing] = useState<{ title: string; body: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", root }),
      }).then((x) => x.json());
      setSkills((r.skills as SkillMeta[]) ?? []);
      setInjected(r.injectedChars ?? 0);
    } catch {
      /* panel stays empty */
    }
  }, [root]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "list", root }),
        }).then((x) => x.json());
        if (!cancelled) {
          setSkills((r.skills as SkillMeta[]) ?? []);
          setInjected(r.injectedChars ?? 0);
        }
      } catch {
        /* panel stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root]);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
      const r = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", root, name: slug, content }),
      });
      const d = await r.json();
      if (!r.ok) setError(String(d.error ?? "could not save"));
      else {
        setName("");
        setContent("");
        setAdding(false);
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function upload(f: File | undefined) {
    if (!f) return;
    setError(null);
    setBusy(true);
    try {
      const slug = (name.trim() || f.name.replace(/\.[^.]+$/, ""))
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      const fd = new FormData();
      fd.append("root", root);
      fd.append("name", slug);
      fd.append("file", f);
      const r = await fetch("/api/skills", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) setError(String(d.error ?? "could not upload"));
      else {
        setName("");
        setAdding(false);
        await refresh();
      }
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function loadLibrary() {
    if (lib) return;
    try {
      setLib(await fetch("/api/standards").then((r) => r.json()));
    } catch {
      /* browser stays empty */
    }
  }

  return (
    <div className="border-t border-slate-100 px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          Project skills
        </span>
        {injected > 0 && (
          <span className="text-[10px] text-slate-300">~{(injected / 1000).toFixed(1)}k chars injected</span>
        )}
        <button
          onClick={() => setAdding((v) => !v)}
          className="ml-auto rounded px-1.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          title="Add project knowledge — injected into every agent prompt for this project"
        >
          {adding ? "✕" : "＋"}
        </button>
      </div>

      {skills.length === 0 && !adding && (
        <p className="mt-1 text-[10px] text-slate-300">
          org-specific knowledge for agents — conventions, landmines, facts
        </p>
      )}

      <div className="mt-1 space-y-0.5">
        {skills.map((s) => (
          <div key={s.name} className="group flex items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-slate-50">
            <button
              onClick={() => onOpenFile?.(`.sfharness/skills/${s.name}.md`)}
              className="flex-1 truncate text-left text-slate-600 hover:text-slate-900"
              title="Open in the editor"
            >
              📘 {s.name}
            </button>
            {s.truncated && (
              <span className="text-[9px] font-semibold text-amber-600" title="exceeds the per-skill injection budget — trim it">
                truncated
              </span>
            )}
            <span className="text-[9px] text-slate-300">{(s.chars / 1000).toFixed(1)}k</span>
            <button
              onClick={async () => {
                if (!confirm(`Delete skill "${s.name}"?`)) return;
                await fetch("/api/skills", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "delete", root, name: s.name }),
                });
                await refresh();
              }}
              className="invisible rounded px-1 text-[10px] text-slate-300 hover:text-red-500 group-hover:visible"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {adding && (
        <div className="mt-2 rounded-lg border border-dashed border-slate-300 p-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name, e.g. trigger-framework"
            spellCheck={false}
            className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-slate-400"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            placeholder="Paste plain text — saved as an .md file and injected into every agent prompt for this project."
            className="mt-1.5 w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-slate-400"
          />
          <p className="mt-1 text-[9px] leading-relaxed text-slate-400">{COVERED_HINT}</p>
          {error && <p className="mt-1 text-[10px] text-red-600">{error}</p>}
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              onClick={save}
              disabled={busy || !name.trim() || !content.trim()}
              className="rounded-md bg-slate-900 px-3 py-1 text-[11px] font-medium text-white hover:bg-slate-700 disabled:opacity-40"
            >
              Save skill
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-50 disabled:opacity-40"
              title="md/txt kept as-is; docx/pdf text-extracted"
            >
              📎 Upload
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.txt,.docx,.pdf"
              className="hidden"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </div>
        </div>
      )}

      <details className="mt-2" onToggle={(e) => (e.target as HTMLDetailsElement).open && void loadLibrary()}>
        <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-widest text-slate-300 hover:text-slate-500">
          Team standards (read-only)
        </summary>
        <div className="mt-1 space-y-0.5">
          {!lib && <p className="text-[10px] text-slate-300">loading…</p>}
          {lib && (
            <>
              <button
                onClick={() => setViewing({ title: "baseline", body: lib.baseline.body })}
                className="block w-full truncate rounded px-1 py-0.5 text-left text-xs text-slate-500 hover:bg-slate-50"
              >
                📕 baseline
              </button>
              {lib.modules.map((m) => (
                <button
                  key={m.name}
                  onClick={() => setViewing({ title: m.name, body: m.body })}
                  className="block w-full truncate rounded px-1 py-0.5 text-left text-xs text-slate-500 hover:bg-slate-50"
                >
                  📕 {m.name}
                </button>
              ))}
              {lib.personas.map((p) => (
                <button
                  key={p.name}
                  onClick={() => setViewing({ title: `${p.name} (persona)`, body: p.body })}
                  className="block w-full truncate rounded px-1 py-0.5 text-left text-xs text-slate-400 hover:bg-slate-50"
                >
                  🎭 {p.name}
                </button>
              ))}
              <p className="pt-0.5 text-[9px] text-slate-300">
                shipped with Dhruva — same for every project, not editable here
              </p>
            </>
          )}
        </div>
      </details>

      {viewing && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-8"
          onClick={(e) => e.target === e.currentTarget && setViewing(null)}
        >
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center">
              <h3 className="text-sm font-semibold">{viewing.title}</h3>
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-400">
                read-only · shipped standard
              </span>
              <button onClick={() => setViewing(null)} className="ml-auto rounded px-2 text-slate-400 hover:text-slate-700">
                ✕
              </button>
            </div>
            <pre className="mt-3 max-h-[70vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
              {viewing.body}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
