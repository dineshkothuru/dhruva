"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";

/** Project skills - per-project knowledge (.dhruva/skills/*.md) with a
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

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <header className="flex items-start gap-2.5 border-b border-slate-100 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-base">
          📘
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-slate-800">Project skills</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            What is true of THIS org - conventions, landmines, facts the code cannot tell an agent.
          </p>
        </div>
        {skills.length > 0 && (
          <div className="shrink-0 text-right">
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
              {skills.length} {skills.length === 1 ? "skill" : "skills"}
            </span>
            {injected > 0 && (
              <p className="mt-1 text-[11px] text-slate-400">
                ~{(injected / 1000).toFixed(1)}k chars injected
              </p>
            )}
          </div>
        )}
      </header>

      <div className="px-4 py-3">
      {skills.length === 0 ? (
        /* empty state: a real invitation, not a button floating in whitespace */
        <div className="flex flex-col items-center rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-4 py-6 text-center">
          <span className="text-2xl opacity-40">📘</span>
          <p className="mt-2 text-xs font-medium text-slate-600">No project skills yet</p>
          <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-slate-400">
            Add what an agent could not work out from the code alone - naming a team follows, an
            integration that must never be touched, a quirk of this org.
          </p>
          <button
            onClick={() => setAdding(true)}
            className="mt-3 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
          >
            ＋ Add the first skill
          </button>
        </div>
      ) : (
      /* skills as compact boxes: click opens the editor, ✕ always visible */
      <div className="flex flex-wrap gap-2">
        {skills.map((s) => (
          <div
            key={s.name}
            className="rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-2.5 pr-1 text-xs hover:border-slate-300"
          >
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onOpenFile?.(`.dhruva/skills/${s.name}.md`)}
                className="font-medium text-slate-600 hover:text-slate-900"
                title={`open in the editor · ${(s.chars / 1000).toFixed(1)}k chars`}
              >
                {<Icon.skill size={12} strokeWidth={1.75} className="inline shrink-0 text-indigo-500" />} {s.name}
              </button>
              {s.truncated && (
                <span className="rounded-md bg-amber-100 px-1 text-[10px] font-semibold uppercase text-amber-600" title="exceeds the injection budget - trim it">
                  truncated
                </span>
              )}
              <button
                onClick={() => setDeleting(s.name)}
                className="rounded-md px-1 text-[11px] text-slate-400 hover:bg-red-50 hover:text-red-500"
                title="Delete this skill"
              >
                ✕
              </button>
            </div>
            <p className="mt-0.5 max-w-56 truncate text-[11px] text-sky-600" title={s.applyTo ?? "always injected"}>
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
      )}
      </div>

      {adding && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-8"
          onClick={(e) => e.target === e.currentTarget && setAdding(false)}
        >
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-center">
              <h3 className="text-sm font-semibold">Add a project skill</h3>
              <button onClick={() => setAdding(false)} className="ml-auto rounded-md px-2 text-slate-400 hover:text-slate-700">
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
          <label className="mt-1.5 block text-[11px] font-medium text-slate-500">
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
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{COVERED_HINT}</p>
          {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
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

      {deleting && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-8"
          onClick={(e) => e.target === e.currentTarget && setDeleting(null)}
        >
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-slate-800">Delete skill &quot;{deleting}&quot;?</h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              The file <span className="font-mono text-[11px]">.dhruva/skills/{deleting}.md</span>{" "}
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

    </section>
  );
}
