"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Project skills - per-project knowledge (.sfharness/skills/*.md) with a
 * read-only browser of the SHIPPED standards library alongside, so authors
 * see what is already covered instead of duplicating it into skills. */

interface SkillMeta {
  name: string;
  chars: number;
  mtime: number;
  truncated: boolean;
  applyTo: string | null;
}

const COVERED_HINT =
  "Already covered by the team standards: Apex (classes, triggers, async, tests), LWC, flows, " +
  "security & FLS, naming, logging, metadata, deployments. Write only what is TRUE OF THIS ORG " +
  "and not derivable from code - conventions, landmines, org facts.";

/** Friendly scoping choices - the glob is written into the file's frontmatter
 * on save; "Everything" writes none. Mirrors the areas the standards cover. */
const SCOPES: { label: string; short: string; glob: string }[] = [
  { label: "Everything (always injected)", short: "everything", glob: "" },
  { label: "Apex classes", short: "apex classes", glob: "force-app/main/default/classes/**/*.cls" },
  { label: "Apex triggers", short: "triggers", glob: "force-app/main/default/triggers/**" },
  { label: "LWC", short: "lwc", glob: "force-app/main/default/lwc/**" },
  { label: "Aura", short: "aura", glob: "force-app/main/default/aura/**" },
  { label: "Flows", short: "flows", glob: "force-app/main/default/flows/**" },
  { label: "Objects & fields", short: "objects & fields", glob: "force-app/main/default/objects/**" },
  { label: "Permissions (perm sets/profiles)", short: "permissions", glob: "force-app/main/default/{permissionsets,profiles}/**" },
  { label: "Metadata XML", short: "metadata xml", glob: "force-app/main/default/**/*-meta.xml" },
  { label: "Custom glob…", short: "", glob: "__custom__" },
];

/** Friendly display for known scopes; custom globs show as-is. */
function scopeLabel(glob: string | null): string {
  if (!glob) return "everything";
  return SCOPES.find((s) => s.glob === glob)?.short || glob;
}

function withScope(content: string, glob: string): string {
  const g = glob.trim();
  if (!g) return content;
  return `---\napplyTo: "${g}"\n---\n\n${content}`;
}

export default function ProjectSkills({
  root,
  onOpenFile,
  active = true,
}: {
  root: string;
  /** Open a project-relative file in the built-in editor. */
  onOpenFile?: (rel: string) => void;
  /** True while the hosting tab is visible - each activation re-fetches, so
   * files added by other means (folder drops, other sessions) show up. */
  active?: boolean;
}) {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [injected, setInjected] = useState(0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState("");
  const [customGlob, setCustomGlob] = useState("");
  const effectiveGlob = scope === "__custom__" ? customGlob : scope;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [lib, setLib] = useState<{
    baseline: { chars: number; body: string };
    modules: { name: string; body: string }[];
    personas: { name: string; body: string }[];
  } | null>(null);
  const [viewing, setViewing] = useState<{ title: string; body: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

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
    if (!active) return;
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
  }, [root, active]);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      const r = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", root, name: slug, content: withScope(content, effectiveGlob) }),
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
      if (effectiveGlob.trim()) fd.append("applyTo", effectiveGlob.trim());
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
      </div>

      {skills.length === 0 && (
        <p className="mt-1 text-[10px] text-slate-300">
          org-specific knowledge for agents - conventions, landmines, facts
        </p>
      )}

      {/* skills as compact boxes: click opens the editor, ✕ always visible */}
      <div className="mt-2 flex flex-wrap gap-2">
        {skills.map((s) => (
          <div
            key={s.name}
            className="rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-2.5 pr-1 text-xs hover:border-slate-300"
          >
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onOpenFile?.(`.sfharness/skills/${s.name}.md`)}
                className="font-medium text-slate-600 hover:text-slate-900"
                title={`open in the editor · ${(s.chars / 1000).toFixed(1)}k chars`}
              >
                📘 {s.name}
              </button>
              {s.truncated && (
                <span className="rounded bg-amber-100 px-1 text-[8px] font-semibold uppercase text-amber-600" title="exceeds the injection budget - trim it">
                  truncated
                </span>
              )}
              <button
                onClick={() => setDeleting(s.name)}
                className="rounded px-1 text-[11px] text-slate-400 hover:bg-red-50 hover:text-red-500"
                title="Delete this skill"
              >
                ✕
              </button>
            </div>
            <p className="mt-0.5 max-w-56 truncate text-[9px] text-sky-600" title={s.applyTo ?? "always injected"}>
              applies to: {scopeLabel(s.applyTo)}
            </p>
          </div>
        ))}
        <button
          onClick={() => setAdding(true)}
          className="rounded-lg border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-400 hover:border-slate-400 hover:text-slate-600"
        >
          ＋ Add skill
        </button>
      </div>

      {adding && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-8"
          onClick={(e) => e.target === e.currentTarget && setAdding(false)}
        >
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center">
              <h3 className="text-sm font-semibold">Add a project skill</h3>
              <button onClick={() => setAdding(false)} className="ml-auto rounded px-2 text-slate-400 hover:text-slate-700">
                ✕
              </button>
            </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name, e.g. trigger-framework"
            spellCheck={false}
            className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-slate-400"
          />
          <div className="relative mt-1.5">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              placeholder="Paste plain text - saved as an .md file and injected into every agent prompt for this project. Or attach a file with ＋ (md/txt kept as-is, docx/pdf text-extracted)."
              className="w-full rounded-md border border-slate-200 px-2 py-1 pr-8 text-xs outline-none focus:border-slate-400"
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="absolute bottom-2.5 right-2 flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
              title="Attach a file as this skill's content - md/txt kept as-is, docx/pdf text-extracted"
            >
              ＋
            </button>
          </div>
          <label className="mt-1.5 block text-[10px] font-medium text-slate-500">
            Applies to (optional - steps not touching matching files skip this skill; analysis
            steps always get everything)
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="mt-0.5 block w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-slate-400"
            >
              {SCOPES.map((s) => (
                <option key={s.label} value={s.glob}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {scope === "__custom__" && (
            <input
              value={customGlob}
              onChange={(e) => setCustomGlob(e.target.value)}
              placeholder="glob, e.g. force-app/main/default/classes/**/*Batch*.cls"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1 font-mono text-[11px] outline-none focus:border-slate-400"
            />
          )}
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
            <input
              ref={fileRef}
              type="file"
              accept=".md,.txt,.docx,.pdf"
              className="hidden"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            </div>
          </div>
        </div>
      )}

      <details className="mt-2" onToggle={(e) => (e.target as HTMLDetailsElement).open && void loadLibrary()}>
        <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-widest text-slate-300 hover:text-slate-500">
          📚 Team standards (read-only)
        </summary>
        <div className="mt-2">
          {!lib && <p className="text-[10px] text-slate-300">loading…</p>}
          {lib && (
            <>
              <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-300">
                Standards - the rules (scoped to matching files)
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {[
                  { title: "baseline", body: lib.baseline.body },
                  ...lib.modules.map((m) => ({ title: m.name, body: m.body })),
                ].map((x) => (
                  <button
                    key={x.title}
                    onClick={() => setViewing({ title: x.title, body: x.body })}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 hover:border-slate-300 hover:text-slate-700"
                    title="view (read-only)"
                  >
                    📕 {x.title}
                  </button>
                ))}
              </div>
              <p className="mt-2.5 text-[9px] font-semibold uppercase tracking-widest text-slate-300">
                Personas - the hats agent steps wear (architect, reviewer, ...)
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {lib.personas.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => setViewing({ title: `${p.name} (persona)`, body: p.body })}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 hover:border-slate-300 hover:text-slate-700"
                    title="view (read-only)"
                  >
                    🎭 {p.name}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[9px] text-slate-300">
                shipped with Dhruva - same for every project, not editable here
              </p>
            </>
          )}
        </div>
      </details>

      {deleting && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-8"
          onClick={(e) => e.target === e.currentTarget && setDeleting(null)}
        >
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-slate-800">Delete skill &quot;{deleting}&quot;?</h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              The file <span className="font-mono text-[11px]">.sfharness/skills/{deleting}.md</span>{" "}
              will be permanently deleted from the project folder. It cannot be recovered from
              Dhruva, and agents stop receiving this knowledge immediately.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleting(null)}
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await fetch("/api/skills", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "delete", root, name: deleting }),
                  });
                  setDeleting(null);
                  await refresh();
                }}
                className="rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-red-700"
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}

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
