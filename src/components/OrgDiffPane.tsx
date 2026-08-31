"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MONACO_OPTIONS, defineDhruvaTheme, PathCrumb } from "@/components/EditorPane";
import { DiffStat, ViewToggle, countDiffLines, langForDiff } from "@/components/DiffPane";
import { Icon } from "@/components/icons";
import { bindModelFile, registerLspCompletions } from "@/components/monacoLsp";

const MonacoDiff = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
});

/** Local file vs the org's copy of it, with the org's side movable INTO the
 * local one.
 *
 * The other diff view (DiffPane) answers "what did this run change?" - two
 * points in local history, read-only, nothing to decide. This one answers a
 * different question: "the org and my folder disagree - which parts of the
 * org's version do I want?" That makes it an editing surface, and the whole
 * design follows from that:
 *
 *  - The ORG is on the LEFT, as Monaco's `original`. That is not cosmetic:
 *    Monaco's revert arrows move content from original into modified, so
 *    org-on-the-left is what makes a per-block "pull this from the org" arrow
 *    exist at all. Putting local on the left would give arrows that push the
 *    other way, which is a deploy, and a deploy does not belong behind a
 *    hover affordance.
 *  - The LOCAL side is editable and starts as exactly what is on disk. Nothing
 *    is written until Save, so taking blocks, undoing them, and hand-editing in
 *    between are all free.
 *  - Neither side is written by opening this view. The org is only read; the
 *    local file is only read until the user saves.
 *
 * The parent gates entry on a clean editor buffer, so the disk content this
 * loads can never be behind unsaved edits in the file's own editor tab. */
/** Re-ask the org for its current copy.
 *
 * This lives in the ORG column header rather than in the toolbar, and that is
 * the whole point of where it sits. Next to "Take all from org" in a toolbar,
 * the two read as the same button: both mention the org, both have a circular
 * or arrow glyph, and nothing on screen says which one costs a network call or
 * which one changes your file. In the column header there is no ambiguity -
 * it is the control for THAT column, and it changes only what that column
 * shows.
 *
 * The two are genuinely different operations:
 *   re-fetch      -> asks the org again (slow, network), changes the ORG side
 *   take all from -> copies org into local (instant, local, undoable), and
 *                    changes only what your file WILL be once you save. */
function OrgRefetch({
  onClick,
  loading,
  elapsed,
  blocked,
}: {
  onClick: () => void;
  loading: boolean;
  elapsed: number;
  blocked: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || blocked}
      className="flex items-center gap-1 rounded-md border border-sky-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 hover:bg-sky-50 disabled:opacity-40"
      title={
        blocked
          ? "Save or undo your local changes first - re-asking the org would discard them"
          : "Ask the org for its current copy again. Does not change your file."
      }
    >
      <Icon.resume size={10} strokeWidth={2.25} className={loading ? "animate-spin" : ""} />
      {loading ? `${elapsed}s` : "Re-fetch"}
    </button>
  );
}

/** Two pixels of travelling sky-blue. The org call is long enough that a
 * static spinner reads as a hang. */
function FetchBar() {
  return (
    <div className="dhruva-progress-track h-0.5 w-full shrink-0 bg-sky-100">
      <div className="dhruva-progress-bar h-full w-full bg-sky-500" />
    </div>
  );
}

export default function OrgDiffPane({
  root,
  file,
  onSaved,
}: {
  root: string;
  file: string;
  /** Called after the local file is written, so the file's editor tab can
   * reload rather than sit on content that is now stale on disk. */
  onSaved?: (file: string) => void;
}) {
  const [data, setData] = useState<{
    org: string | null;
    local: string | null;
    type?: string;
    fetchedAt?: number;
    cached?: boolean;
  } | null>(null);
  const [buf, setBuf] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sideBySide, setSideBySide] = useState(true);
  const [stats, setStats] = useState<{ add: number; del: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diffRef = useRef<any>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Bumped to re-ask the org. The fetch lives in an effect rather than in the
  // handler so the mount case and the refresh case are the same code path -
  // and so nothing sets state synchronously in the effect body.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/compare-org", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // reloadKey > 0 only ever comes from Re-fetch, which must go to the
          // org rather than be served from the cache.
          body: JSON.stringify({ root, file, force: reloadKey > 0 }),
        });
        const d = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(String(d.error ?? "could not compare with the org"));
          setData(null);
        } else {
          setError(null);
          setData(d);
          setBuf(String(d.local ?? ""));
          setSavedAt(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, file, reloadKey]);

  // An org retrieve is one sf CLI call: roughly four seconds of process boot
  // before a single byte moves, then the Metadata API round trip. Ten to
  // fifteen seconds is normal, and without a counter that is indistinguishable
  // from a hang - so the wait is narrated rather than hidden.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [loading, reloadKey]);

  const refresh = useCallback(() => {
    setLoading(true);
    setElapsed(0);
    setReloadKey((k) => k + 1);
  }, []);

  const lang = langForDiff(file);
  const org = data?.org ?? "";
  const orgMissing = data !== null && data.org === null;
  const localMissing = data !== null && data.local === null;
  const dirty = data !== null && buf !== (data.local ?? "");
  const identical = data !== null && !orgMissing && !localMissing && org === buf;

  /** Replace the whole local side with the org's version. Goes through
   * executeEdits rather than setValue so it lands on the undo stack - one
   * Ctrl+Z puts back what the user had. */
  function takeAllFromOrg() {
    const mod = diffRef.current?.getModifiedEditor?.();
    const model = mod?.getModel?.();
    if (!mod || !model) {
      setBuf(org);
      return;
    }
    mod.pushUndoStop();
    mod.executeEdits("dhruva.take-all-from-org", [
      { range: model.getFullModelRange(), text: org },
    ]);
    mod.pushUndoStop();
  }

  function goToChange(dir: "next" | "previous") {
    try {
      diffRef.current?.goToDiff?.(dir);
    } catch {
      /* older monaco without goToDiff - the gutter arrows still work */
    }
  }

  const save = useCallback(async () => {
    // The dirty check belongs HERE, not only on the button's disabled state.
    // Ctrl+S reaches this directly, and a no-op save is not harmless: it
    // rewrites the file and bumps its mtime, which makes the snapshot store
    // report an untouched file as changed on the next run.
    if (saving || localMissing || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, file, action: "write", content: buf }),
      });
      const d = await res.json();
      if (!res.ok) setError(String(d.error ?? "could not save"));
      else {
        // The saved buffer IS the local side now, so the diff rebaselines
        // against it and the dirty dot clears without a refetch of the org.
        setData((prev) => (prev ? { ...prev, local: buf } : prev));
        setSavedAt(Date.now());
        onSaved?.(file);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [buf, dirty, file, localMissing, onSaved, root, saving]);

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  // Ctrl+S has to work from anywhere in this pane, not just from inside the
  // editor. Monaco's addCommand only fires while the editor itself holds
  // focus, and the natural gesture here is to click "Take all from org" - a
  // DOM button - and then hit Ctrl+S. At that point focus is on the button,
  // Monaco never sees the key, and the BROWSER's save-page dialog opens
  // instead. Hence a window listener.
  //
  // Every pane stays mounted and is hidden with CSS, so a bare window listener
  // would also fire for compare tabs the user cannot see - and they each hold
  // their own unsaved buffer. offsetParent is null for a display:none subtree,
  // which makes "am I the visible one?" a one-line check.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "s" && e.key !== "S") return;
      if (!e.ctrlKey && !e.metaKey) return;
      if (!rootRef.current?.offsetParent) return;
      e.preventDefault();
      void saveRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading && !data) {
    return (
      <div className="flex h-full flex-col">
        <FetchBar />
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-8 text-center">
          <span className="flex items-center gap-2">
            <Icon.resume size={16} strokeWidth={1.75} className="animate-spin text-sky-500" />
            <span className="text-xs font-medium text-slate-700">Retrieving from the org…</span>
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-slate-500">
              {elapsed}s
            </span>
          </span>
          <p className="max-w-sm text-[11px] leading-relaxed text-slate-400">
            Pulling just this one component into a temporary folder, so nothing on disk changes.
            The Salesforce CLI takes a few seconds to start before the retrieve itself begins.
          </p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Icon.warn size={20} strokeWidth={1.75} className="text-red-400" />
        <p className="text-xs font-medium text-red-600">Could not compare with the org</p>
        <p className="max-w-md text-[11px] leading-relaxed text-slate-500">{error}</p>
        <button
          onClick={refresh}
          className="mt-1 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium hover:bg-slate-50"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      {/* Refresh keeps the previous diff on screen, so the bar is the only
          thing saying a new retrieve is running. */}
      {loading && <FetchBar />}
      {/* identity row: which file, what it is, how it compares */}
      <div className="flex items-center gap-2.5 border-b border-slate-200 bg-white px-4 py-2.5">
        <Icon.globe size={14} strokeWidth={1.75} className="shrink-0 text-sky-500" />
        <PathCrumb file={file} />

        {data?.type && (
          <span className="hidden shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 sm:inline">
            {data.type}
          </span>
        )}
        {orgMissing && (
          <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-inset ring-amber-200">
            not in org
          </span>
        )}
        {localMissing && (
          <span className="shrink-0 rounded-md bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 ring-1 ring-inset ring-red-200">
            missing locally
          </span>
        )}
        {identical && (
          <span className="shrink-0 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200">
            in sync
          </span>
        )}
        {stats && <DiffStat add={stats.add} del={stats.del} />}

        <div className="ml-auto flex items-center gap-2">
          <ViewToggle sideBySide={sideBySide} onChange={setSideBySide} />
        </div>
      </div>

      {/* action row: everything that MOVES code, kept apart from the identity
          row so a destructive click is never next to a view toggle */}
      {data && !localMissing && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
          {/* Points from the Org column into the Local column - the direction
              content actually travels on screen. It pointed left first, which
              read as "send this to the org": the exact opposite, and the one
              misreading that would matter. */}
          <Icon.arrowRight size={13} strokeWidth={2} className="shrink-0 text-sky-500" />
          <p className="min-w-0 truncate text-[11px] text-slate-500">
            {identical ? (
              <>This file matches the org exactly.</>
            ) : orgMissing ? (
              <>
                The org has no such component - everything here is local only. Nothing to pull.
              </>
            ) : (
              <>
                Hover any change and click the{" "}
                <span className="font-semibold text-slate-700">revert arrow</span> in the middle
                gutter to pull just that block from the org. Nothing is written until you save.
              </>
            )}
          </p>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!identical && !orgMissing && (
              <>
                <div className="flex items-center rounded-lg border border-slate-300 bg-white">
                  <button
                    onClick={() => goToChange("previous")}
                    className="rounded-l-lg px-1.5 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                    title="Previous change"
                  >
                    <Icon.arrowUp size={12} strokeWidth={2} />
                  </button>
                  <span className="h-4 w-px bg-slate-200" />
                  <button
                    onClick={() => goToChange("next")}
                    className="rounded-r-lg px-1.5 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                    title="Next change"
                  >
                    <Icon.arrowDown size={12} strokeWidth={2} />
                  </button>
                </div>
                <button
                  onClick={takeAllFromOrg}
                  className="flex items-center gap-1.5 rounded-lg border border-sky-300 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-800 hover:bg-sky-100"
                  title="Copy the org's whole version into your local side. No org call - this uses what is already on screen. Ctrl+Z undoes it, and nothing is written until you save."
                >
                  <Icon.arrowRight size={12} strokeWidth={2.25} />
                  Take all from org
                </button>
              </>
            )}
            {dirty && (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-amber-400"
                title="unsaved changes (Ctrl+S to save)"
              />
            )}
            {savedAt && !dirty && <span className="text-[11px] text-emerald-600">saved</span>}
            {error && <span className="max-w-[16rem] truncate text-[11px] text-red-600">{error}</span>}
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="rounded-lg bg-slate-900 px-3 py-1 text-[11px] font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
              title="Write the local side to disk (Ctrl+S)"
            >
              {saving ? "Saving…" : "Save to local"}
            </button>
          </div>
        </div>
      )}

      {localMissing && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2">
          <Icon.warn size={13} strokeWidth={2} className="shrink-0 text-red-500" />
          <p className="text-[11px] text-red-700">
            This file is not on disk, so there is nothing to save into. Use{" "}
            <span className="font-semibold">Retrieve from org</span> in the Org Browser to bring the
            component down first.
          </p>
        </div>
      )}

      {/* Which side is which, directly over the column it describes.
          These labels were in the header bar first, and that was wrong: a
          chip pair reading "Org > Local" up in the toolbar tells you the
          direction but not WHICH HALF OF THE SCREEN is which, and the half
          that accepts edits is exactly the thing you must not have to guess.
          Over the column, there is nothing left to infer.

          The split is a plain 50/50 to match Monaco's own default ratio.
          Dragging the sash between the panes moves the code but not these
          labels; the alternative is reading Monaco's internal widths on every
          layout, which is a lot of machinery for a label that is still
          unambiguous when the halves are uneven. */}
      {data && !localMissing && (
        <div className="flex shrink-0 border-b border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide">
          {sideBySide ? (
            <>
              <div className="flex w-1/2 items-center gap-1.5 border-r border-slate-200 px-4 py-1 text-sky-700">
                <Icon.globe size={11} strokeWidth={2.25} className="shrink-0" />
                Org
                <span className="truncate font-medium normal-case tracking-normal text-slate-400">
                  read-only
                </span>
                <span className="ml-auto" />
                {/* No ticking age here on purpose: reading the clock during
                    render is impure, and a number captured once would sit
                    there going quietly stale - worse than no number. The chip
                    says the org side came from memory; Re-fetch is right next
                    to it when that is not good enough. */}
                {data.cached && (
                  <span
                    className="ml-auto rounded-md bg-white px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-slate-400 ring-1 ring-inset ring-slate-200"
                    title="Served from memory - this component was fetched from the org on an earlier compare, within the last two minutes. Re-fetch asks the org again."
                  >
                    cached
                  </span>
                )}
                <OrgRefetch onClick={refresh} loading={loading} elapsed={elapsed} blocked={dirty} />
              </div>
              <div className="flex w-1/2 items-center gap-1.5 px-4 py-1.5 text-slate-800">
                <Icon.monitor size={11} strokeWidth={2.25} className="shrink-0" />
                Local
                <span className="truncate font-medium normal-case tracking-normal text-slate-400">
                  editable · Ctrl+S to save
                </span>
              </div>
            </>
          ) : (
            /* One column, so the labels have to say what the colours mean -
               otherwise "inline" leaves you guessing which side each line
               came from. */
            <div className="flex w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 py-1 text-slate-800">
              <Icon.inline size={11} strokeWidth={2.25} className="shrink-0" />
              Inline
              <span className="font-medium normal-case tracking-normal text-slate-400">
                ·
                <span className="mx-1 rounded bg-red-50 px-1 font-semibold text-red-600 ring-1 ring-inset ring-red-100">
                  removed
                </span>
                is the org&apos;s version,
                <span className="mx-1 rounded bg-emerald-50 px-1 font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-100">
                  added
                </span>
                is your local file (editable · Ctrl+S to save)
              </span>
              <OrgRefetch onClick={refresh} loading={loading} elapsed={elapsed} blocked={dirty} />
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <MonacoDiff
          height="100%"
          language={lang}
          original={org}
          modified={buf}
          onMount={(editor, monaco) => {
            diffRef.current = editor;
            defineDhruvaTheme(monaco);
            monaco.editor.setTheme("dhruva");
            editor.onDidUpdateDiff(() => setStats(countDiffLines(editor)));
            const mod = editor.getModifiedEditor();
            // The local side of a compare is editable, so it gets the same
            // completions the editor tab has. The org side deliberately does
            // not - it is read-only, and suggesting edits there would invite
            // typing into a pane whose changes are discarded.
            registerLspCompletions(monaco);
            bindModelFile(mod.getModel(), root, file);
            // The buffer is mirrored into React state rather than read on
            // demand, because the gutter arrows edit the model directly - the
            // dirty flag and the Save payload have to see those too.
            mod.onDidChangeModelContent(() => setBuf(mod.getValue()));
            mod.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
              void saveRef.current(),
            );
          }}
          options={{
            ...MONACO_OPTIONS,
            // The whole point: the local side takes edits, the org side does
            // not, and renderMarginRevertIcon is what draws the per-block
            // arrow that moves org content into local.
            readOnly: false,
            originalEditable: false,
            renderMarginRevertIcon: true,
            renderSideBySide: sideBySide,
            // Monaco silently falls back to the inline view when it decides
            // the pane is too narrow for two columns. That turned "Split" into
            // a button that visibly did nothing, and it would also put the
            // two column headers above a single column. The toggle is the
            // authority on which view is shown.
            useInlineViewWhenSpaceIsLimited: false,
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
      </div>
    </div>
  );
}
