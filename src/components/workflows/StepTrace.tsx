"use client";

/** The step trace: everything inside one step's box in a run.
 *
 * Split out of WorkflowsPane, which had grown past 2,300 lines and mixed
 * three unrelated jobs (workflow catalog, run view, and this). Pure move -
 * no behaviour change.
 *
 * Rendering is entirely deterministic parsing of text the agent already
 * printed, so opening a step costs nothing. When a step ends with the
 * structured outcome block (src/lib/outcome.ts) that is used verbatim;
 * otherwise the heuristics below infer what they can. */

import { useEffect, useRef, useState } from "react";
import CliResult from "@/components/workflows/CliResult";
import { inlineCode, parseRequirements, ReqBody } from "@/components/workflows/RequirementCards";
import { parseFindings, type Finding } from "@/lib/findings";
import { parseOutcome, stripOutcome } from "@/lib/outcome";
import { Icon, type IconType } from "@/components/icons";
import type { AgentId } from "@/lib/agents";
import type { RunState } from "@/lib/workflows/schema";

/** Severity is carried by the HEADER BAND, not by a left rail. The card
 * already states severity in its chip; a heavy colored edge on top of that
 * was a third signal for the same fact, and an asymmetric one - thick on the
 * left, flat everywhere else. Tinting the band instead reads as one object,
 * and the body stays neutral so the text is what you look at. */
const SEV_STYLE: Record<Finding["severity"], { head: string; chip: string; ring: string }> = {
  critical: {
    head: "bg-red-50 border-red-100",
    chip: "bg-red-600 text-white",
    ring: "ring-red-200",
  },
  important: {
    head: "bg-amber-50 border-amber-100",
    chip: "bg-amber-500 text-white",
    ring: "ring-amber-200",
  },
  nit: {
    head: "bg-slate-100 border-slate-200",
    chip: "bg-slate-400 text-white",
    ring: "ring-slate-200",
  },
};

/** One reviewer finding as a designed card - severity edge, labeled fields. */
export function FindingCard({ f }: { f: Finding }) {
  const sev = SEV_STYLE[f.severity];
  return (
    <div className={`overflow-hidden rounded-lg bg-white shadow-sm ring-1 ${sev.ring}`}>
      {/* header band carries the severity - tinted, with the id, refs and title */}
      <div className={`flex flex-wrap items-center gap-1.5 border-b px-3 py-2 ${sev.head}`}>
        <span className="font-mono text-[11px] font-bold text-slate-600">{f.id}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${sev.chip}`}>
          {f.severity}
        </span>
        {f.refs.map((r) => (
          <span key={r} className="rounded-full bg-sky-100 px-2 py-0.5 font-mono text-[11px] text-sky-700">
            {r}
          </span>
        ))}
        <span className="w-full text-xs font-semibold text-slate-800 sm:w-auto sm:flex-1">{f.title}</span>
      </div>
      {/* issue body */}
      {(f.where || f.problem) && (
        <div className="px-3 py-2">
          {f.where && (
            <p className="truncate font-mono text-[11px] text-slate-400" title={f.where}>
              {<Icon.info size={11} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} {f.where}
            </p>
          )}
          {f.problem && (
            <p className={`text-xs leading-relaxed text-slate-700 ${f.where ? "mt-1.5" : ""}`}>
              {f.problem}
            </p>
          )}
        </div>
      )}
      {/* fix panel */}
      {f.fix && (
        <div className="border-t border-emerald-100 bg-emerald-50 px-3 py-2">
          <p className="text-xs leading-relaxed text-emerald-800">
            <span className="mr-1 rounded-md bg-emerald-600 px-1.5 py-px text-[11px] font-bold uppercase tracking-wide text-white">
              Fix
            </span>{" "}
            {f.fix}
          </p>
        </div>
      )}
    </div>
  );
}


/** Catalog grouping - anything unlisted lands in the first group. */
export const CATEGORIES: [string, string[]][] = [
  ["Development", ["bug-fix", "feature-dev", "solution-design", "ux-design", "implement-tdd"]],
  ["Testing", ["test-gen", "run-tests"]],
  ["Org & deployment", ["retrieve-sync", "deploy-preview", "validate-deploy", "scratch-org"]],
  ["Custom", []],
];

export const AGENT_OPTIONS: { id: AgentId; label: string }[] = [
  { id: "copilot", label: "GitHub Copilot" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "OpenAI Codex" },
  { id: "cursor", label: "Cursor" },
];

/** Status face per step. Components, so they inherit the status color and
 * stay aligned with the text beside them. */
export const STATUS_ICON: Record<string, IconType> = {
  pending: Icon.pending,
  running: Icon.running,
  waiting_gate: Icon.humanGate,
  done: Icon.ok,
  failed: Icon.failed,
  skipped: Icon.skipped,
};

/** Colored left edge per step status - the run's frontier at a glance. */
export const STATUS_EDGE: Record<string, string> = {
  pending: "border-l-slate-200",
  running: "border-l-sky-400",
  waiting_gate: "border-l-amber-400",
  done: "border-l-emerald-400",
  failed: "border-l-red-400",
  skipped: "border-l-slate-200",
};

/** Type chip tint: AI steps stand apart from deterministic ones. */
export const TYPE_CHIP: Record<string, string> = {
  agent: "bg-violet-50 text-violet-600",
  gate: "bg-amber-50 text-amber-600",
  verify: "bg-teal-50 text-teal-600",
  cli: "bg-slate-100 text-slate-500",
  snapshot: "bg-slate-100 text-slate-500",
  changes: "bg-slate-100 text-slate-500",
  "tasks-check": "bg-teal-50 text-teal-600",
};

export function runCost(r: RunState): number {
  return r.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
}
export function fmtCost(c: number): string {
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

/** Structured step-output view: agent narration as prose, tool calls as
 * rows, exit/engine/error lines as badges; auto-follows while streaming. */
export default function StepBody({
  output: rawOutput,
  type,
  running,
  baseCommit,
  onOpenDiff,
}: {
  output: string;
  type: string;
  running: boolean;
  /** changes steps: the commit this diff was taken against */
  baseCommit?: string;
  onOpenDiff?: (rel: string, pin?: { base?: string; end?: string }) => void;
}) {
  // The agent states its own outcome in a fixed block when the workflow asks
  // for one. That is authoritative; the pattern-counting further down stays
  // as the fallback for older runs and customs that have not adopted it.
  const stated = parseOutcome(rawOutput);
  const output = stated ? stripOutcome(rawOutput) : rawOutput;

  const boxRef = useRef<HTMLDivElement>(null);
  // structured view by default; the toggle shows the untouched raw trace
  const [raw, setRaw] = useState(false);
  // which half of the header is showing. Result by default - the activity is
  // evidence you open when you want it. A RUNNING step opens on activity,
  // because there is no result yet and the tool trace is the live story.
  // Stored as "what the user explicitly picked", not as the resolved tab, so
  // the default can follow the step's state without fighting the user.
  const [choice, setChoice] = useState<"did" | "result" | null>(null);
  const [wasRunning, setWasRunning] = useState(running);
  if (wasRunning !== running) {
    // the step just finished: drop any choice made while it was live, so a
    // completed step always lands on its outcome
    setWasRunning(running);
    setChoice(null);
  }
  const tab = choice ?? (running ? "did" : "result");
  const setTab = setChoice;
  useEffect(() => {
    if (running) boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [output, running]);

  if (!output) {
    return running ? (
      <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-400">
        <span className="mr-1 inline-block animate-pulse text-sky-500">●</span>
        running - output streams here…
      </p>
    ) : null;
  }

  // cli steps: render recognized sf --json shapes as tables once finished
  // (CliResult falls back to the terminal view for unrecognized output)
  if (type === "cli" && !running) {
    return <CliResult output={output} />;
  }

  // ---- non-agent steps. These are deterministic engine output, so they
  // parse exactly rather than heuristically - and they deserve a layout as
  // much as the agent steps do. All string parsing, no tokens.
  if (type === "snapshot" && !running) {
    const ok = /taken/i.test(output);
    return (
      <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3">
        {ok ? (
          <Icon.ok size={14} strokeWidth={2} className="shrink-0 text-emerald-600" />
        ) : (
          <Icon.warn size={14} strokeWidth={2} className="shrink-0 text-amber-500" />
        )}
        <p className="text-xs text-slate-600">
          {ok
            ? "Baseline captured. Every change from here is attributable to this run."
            : output}
        </p>
      </div>
    );
  }

  if (type === "tasks-check" && !running) {
    const valid = /tasks file valid/i.test(output);
    const counts = output.match(/(\d+) task\(s\), (\d+) pending/);
    const order = output.match(/execution order:\s*(.+)/)?.[1]?.trim();
    const ids = order && order !== "(none pending)" ? order.split(/\s*[→>]+\s*/) : [];
    const errs = output.split("\n").filter((l) => l.trim().startsWith("- "));
    return (
      <div className="space-y-2 border-t border-slate-100 px-4 py-3">
        <p className="flex items-center gap-1.5 text-xs">
          {valid ? (
            <Icon.ok size={13} strokeWidth={2} className="shrink-0 text-emerald-600" />
          ) : (
            <Icon.warn size={13} strokeWidth={2} className="shrink-0 text-red-500" />
          )}
          <span className={valid ? "text-slate-700" : "font-medium text-red-700"}>
            {valid
              ? counts
                ? `Build plan is valid: ${counts[1]} tasks, ${counts[2]} still pending.`
                : "Build plan is valid."
              : "Build plan rejected"}
          </span>
        </p>
        {ids.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Order
            </span>
            {ids.map((id, k) => (
              <span key={`${id}-${k}`} className="flex items-center gap-1">
                {k > 0 && <Icon.chevron size={10} strokeWidth={2} className="text-slate-300" />}
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                  {id}
                </span>
              </span>
            ))}
          </div>
        )}
        {errs.length > 0 && (
          <ul className="space-y-0.5">
            {errs.map((e, k) => (
              <li key={k} className="text-[11px] leading-relaxed text-red-700">
                {e.replace(/^-\s*/, "")}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (type === "verify" && !running) {
    const passed = /standards check passed|no changed files/i.test(output);
    // "ERROR    rule    file" followed by an indented detail line
    const rows: { sev: string; rule: string; file: string; detail: string }[] = [];
    const lines = output.split("\n");
    lines.forEach((l, k) => {
      const m = l.match(/^(ERROR|WARN|WARNING)\s+(\S+)\s+(\S+)\s*$/);
      if (m) rows.push({ sev: m[1], rule: m[2], file: m[3], detail: (lines[k + 1] ?? "").trim() });
    });
    const summary = output.match(/(\d+) error-level violation\(s\)[^\n]*/)?.[0];
    const firstLine = lines[0] ?? "";
    return (
      <div className="space-y-2 border-t border-slate-100 px-4 py-3">
        <p className="flex items-center gap-1.5 text-xs">
          {passed ? (
            <Icon.ok size={13} strokeWidth={2} className="shrink-0 text-emerald-600" />
          ) : (
            <Icon.warn size={13} strokeWidth={2} className="shrink-0 text-red-500" />
          )}
          <span className={passed ? "text-slate-700" : "font-medium text-red-700"}>
            {passed ? firstLine : (summary ?? `${rows.length} standards violation(s)`)}
          </span>
        </p>
        {rows.map((r, k) => (
          <div
            key={k}
            className={`rounded-lg border px-2.5 py-1.5 ${
              /ERROR/.test(r.sev) ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
            }`}
          >
            <p className="flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded px-1.5 text-[9px] font-bold uppercase text-white ${
                  /ERROR/.test(r.sev) ? "bg-red-600" : "bg-amber-500"
                }`}
              >
                {r.sev}
              </span>
              <span className="font-mono text-[11px] font-semibold text-slate-700">{r.rule}</span>
              <span className="truncate font-mono text-[10px] text-slate-500">{r.file}</span>
            </p>
            {r.detail && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">{r.detail}</p>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (type === "changes" && !running) {
    if (/no files changed/i.test(output)) {
      return (
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          No files changed by this run.
        </p>
      );
    }
    // This used to return null on the assumption that the run view already
    // shows the list. It does - but only for ONE changes step, because each
    // overwrites run.changes. A workflow with two of them (retrieve-delta, then
    // changes) left the first as a row that would not open, hiding the whole
    // org-drift report it exists to produce.
    const files = output
      .split(/\r?\n/)
      .map((l) => l.match(/^(modified|added|deleted)\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ status: m[1], file: m[2].trim() }));
    if (files.length === 0) {
      return (
        <div className="max-h-72 overflow-y-auto border-t border-slate-100">
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-slate-600">
            {output}
          </pre>
        </div>
      );
    }
    return (
      <div className="border-t border-slate-100">
        <p className="px-4 pt-2.5 text-[11px] text-slate-500">
          {files.length} file{files.length === 1 ? "" : "s"} differed from the snapshot taken
          before this step
          {onOpenDiff && baseCommit ? " - open one to see the diff" : ""}
        </p>
        <div className="max-h-72 overflow-y-auto px-2 pb-2 pt-1">
          {files.map((c) => {
            const row = (
              <>
                <span className="mr-2 text-[11px] font-semibold uppercase text-amber-600">
                  {c.status}
                </span>
                {c.file}
              </>
            );
            return onOpenDiff && baseCommit ? (
              <button
                key={c.file}
                onClick={() => onOpenDiff(c.file, { base: baseCommit })}
                className="block w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-slate-100"
                title="Open diff against the snapshot before this step"
              >
                {row}
              </button>
            ) : (
              <p key={c.file} className="truncate px-2 py-1 font-mono text-xs text-slate-600">
                {row}
              </p>
            );
          })}
        </div>
      </div>
    );
  }

  // anything else (streaming cli, engine notices) stays terminal-style
  if (type !== "agent") {
    return (
      <div ref={boxRef} className="max-h-72 overflow-y-auto border-t border-slate-100">
        <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-slate-600">
          {output}
        </pre>
      </div>
    );
  }

  // ---- agent trace: structured for humans. Narration stays prominent; tool
  // activity collapses into groups; denials are highlighted; reviewer findings
  // render as designed cards; a verdict banner summarizes review steps at the
  // top. All deterministic parsing - zero tokens.
  const verdict = output.match(/VERDICT:\s*(APPROVED|READY|BLOCKED)[^\n]*/i);
  const coverage = output.match(/COVERAGE:\s*(COMPLETE|INCOMPLETE)[^\n]*/i);
  const parsed = parseFindings(output);
  const findingsCount = parsed.findings.length;
  // per-requirement design blocks (analyse output) render as cards too
  const reqFirst = output.search(/^### REQ-\d+/m);
  // req blocks end where the findings begin - otherwise the LAST req card
  // swallows the whole findings text into its DESIGN field
  const findFirst = output.search(/^\*{0,2}F\d+[\s:(]/m);
  const reqSource = findFirst > reqFirst && findFirst >= 0 ? output.slice(0, findFirst) : output;
  const reqItems = reqFirst >= 0 ? parseRequirements(reqSource) : [];

  const isMdTableRow = (t: string) => /^\s*\|.*\|\s*$/.test(t) && (t.match(/\|/g) ?? []).length >= 3;
  const isTool = (raw: string) => {
    const t = raw.trimStart(); // continuation lines are often indented
    // a markdown table row leads with an ASCII pipe too - it belongs to the
    // agent's prose, not to the collapsed tool trace
    if (isMdTableRow(t)) return false;
    return /^[⚙●○◦]\s?/.test(t) || /^[│|├└╰]\s?/.test(t) || /^[Xx✗]\s+\S/.test(t) || /^\/\s?\S/.test(t);
  };
  type Seg = { kind: "text" | "engine" | "exit" | "toolgroup" | "table"; lines: string[] };
  const buildSegs = (text: string): Seg[] => {
    const out: Seg[] = [];
    for (const raw of text.split("\n")) {
      const t = raw.trimEnd();
      if (!t) continue;
      if (/^VERDICT:|^COVERAGE:/i.test(t)) continue; // shown in the banner
      const kind: Seg["kind"] = /^\[exit -?\d+\]$/.test(t)
        ? "exit"
        : t.startsWith("[engine]") || t.startsWith("[agent error]")
          ? "engine"
          : isMdTableRow(t)
            ? "table"
            : isTool(t)
              ? "toolgroup"
              : "text";
      const last = out[out.length - 1];
      if ((kind === "toolgroup" || kind === "table") && last?.kind === kind) last.lines.push(t);
      else out.push({ kind, lines: [t] });
    }
    return out;
  };
  let beforeText = parsed.before;
  let trailingText = parsed.trailing;
  if (reqItems.length > 0) {
    beforeText = output.slice(0, reqFirst);
    const tailM = output.match(/((?:\n\[(?:engine|agent error|exit)[^\n]*)+)\s*$/);
    trailingText = tailM ? tailM[1] : "";
  }
  const segs = buildSegs(beforeText);
  const trailingSegs = buildSegs(trailingText);

  // ---- end-of-step summary: WHAT it did + WHAT it produced (deterministic)
  const allTool = [...segs, ...trailingSegs]
    .filter((s) => s.kind === "toolgroup")
    .flatMap((s) => s.lines);
  const didVerbs = new Map<string, number>();
  for (const l of allTool) {
    const m = l.match(/^[●⚙Xx✗]\s*([A-Za-z_-]+)/);
    if (m) didVerbs.set(m[1], (didVerbs.get(m[1]) ?? 0) + 1);
  }
  const blockedN = allTool.filter((l) => /denied/i.test(l)).length;
  const did =
    [...didVerbs.entries()].map(([v, n]) => (n > 1 ? `${v} ×${n}` : v)).join(", ") +
    (blockedN ? ` · ${blockedN} blocked by read-only rules` : "");
  const produced: string[] = [];
  if (reqItems.length > 0) {
    const byStatus = new Map<string, number>();
    for (const r of reqItems) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    produced.push(
      `${reqItems.length} requirement designs (${[...byStatus.entries()].map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ")})`,
    );
  }
  if (findingsCount > 0 && verdict) produced.push(`${findingsCount} findings · ${verdict[0]}`);
  else if (verdict) produced.push(verdict[0]);
  const covLines = output.match(/^\s*(?:(?:REQ|UC|UX)-\w+|\d+\.)[^\n]*?\b(COVERED|IMPLEMENTED|PARTIAL|MISSING|DIVERGES|SKIPPED)\b/gim) ?? [];
  if (coverage && covLines.length > 0) {
    const c = (w: string) => covLines.filter((l) => new RegExp(`\\b${w}\\b`, "i").test(l)).length;
    const bits = [
      c("COVERED") + c("IMPLEMENTED") ? `${c("COVERED") + c("IMPLEMENTED")} covered` : "",
      c("PARTIAL") ? `${c("PARTIAL")} partial` : "",
      c("MISSING") ? `${c("MISSING")} missing` : "",
      c("DIVERGES") ? `${c("DIVERGES")} diverge` : "",
    ].filter(Boolean);
    produced.push(`${coverage[0]} (${bits.join(", ")})`);
  } else if (coverage) produced.push(coverage[0]);
  const taskMarks = output.match(/━━ (?:T|fix)-\d+ \((\d+)\/(\d+)\)/g) ?? [];
  if (taskMarks.length > 0) {
    const total = taskMarks[taskMarks.length - 1].match(/\/(\d+)\)/)?.[1];
    produced.push(`${taskMarks.length}/${total ?? taskMarks.length} build-plan tasks executed`);
  }
  const filesLine = output.match(/FILES:\s*([^\n]+)/);
  if (filesLine) produced.push(`${filesLine[1].split(",").length} file(s) named for retrieval`);
  const uxBlocks = (output.match(/^UX-\d+/gm) ?? []).length;
  if (uxBlocks > 0) produced.push(`${uxBlocks} UX component designs`);
  // whatever the agent stated replaces the guesses entirely - mixing the two
  // would double-count the same work in different words
  const producedFinal = stated?.produced.length ? stated.produced : produced;

  // ---- two-section layout (activity vs output): while the agent runs, WHAT
  // IT IS READING is the story; once done, WHAT IT PRODUCED is. Activity =
  // everything up to and including the last tool call (tool groups + the
  // progress narration between them); it stays live while running and
  // collapses to a single reviewable line when finished.
  const lastToolIdx = segs.reduce((acc, sg, si) => (sg.kind === "toolgroup" ? si : acc), -1);
  const activitySegs = lastToolIdx >= 0 ? segs.slice(0, lastToolIdx + 1) : [];
  const postToolSegs = lastToolIdx >= 0 ? segs.slice(lastToolIdx + 1) : segs;

  type RSeg = {
    kind: "text" | "engine" | "exit" | "toolgroup" | "table" | "cards" | "reqcards" | "summary";
    lines: string[];
  };
  const renderSeg = (seg: RSeg, i: number) => {
        if (seg.kind === "cards") {
          return (
            <div key={`cards-${i}`} className="space-y-2 py-1">
              {parsed.findings.map((f, fi) => (
                <FindingCard key={`${f.id}-${fi}`} f={f} />
              ))}
            </div>
          );
        }
        if (seg.kind === "reqcards") {
          return (
            <div key={`reqs-${i}`} className="space-y-1.5 py-1">
              {reqItems.map((r) => (
                <details key={r.id} className="rounded-lg border border-slate-200 bg-white">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-1.5 px-3 py-1.5">
                    <span className="font-mono text-[11px] text-slate-400">{r.id}</span>
                    <span className="text-xs font-semibold text-slate-800">{r.title}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${
                        r.status.toUpperCase() === "ALREADY IMPLEMENTED"
                          ? "bg-emerald-50 text-emerald-700"
                          : r.status.toUpperCase() === "PARTIAL"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-sky-50 text-sky-700"
                      }`}
                    >
                      {r.status}
                    </span>
                  </summary>
                  <div className="border-t border-slate-100 px-3 py-2.5">
                    <ReqBody body={r.body} />
                  </div>
                </details>
              ))}
            </div>
          );
        }
        if (seg.kind === "summary") {
          return (
            <div
              key={`sum-${i}`}
              className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2"
            >
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-emerald-700">
                <Icon.ok size={12} strokeWidth={2} />
                Outcome
              </p>
              <p className="mt-1 text-xs leading-relaxed text-emerald-900/85">
                {produced.join(" · ")}
              </p>
            </div>
          );
        }
        if (seg.kind === "table") {
          const rows = seg.lines
            .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
            // the |---|---| separator row carries no data
            .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
          if (rows.length === 0) return null;
          const [head, ...body] = rows;
          // A path or api-name column is reference data - it should not crowd
          // out the column that carries the actual requirement. Narrow those,
          // let the descriptive columns take the room.
          const isRef = head.map((h) => /path|file|location|api name|component|metadata/i.test(h));
          return (
            <div key={`tbl-${i}`} className="my-1.5 overflow-x-auto rounded-lg border border-slate-200">
              {/* a fixed layout in a narrow pane crushes every column to a few
                  characters; give the table a floor width and let the wrapper
                  scroll instead */}
              <table
                className="w-full table-fixed border-collapse text-left text-[11px]"
                style={{ minWidth: `${Math.max(460, head.length * 150)}px` }}
              >
                <colgroup>
                  {head.map((_, ci) => (
                    <col key={ci} style={{ width: isRef[ci] ? "22%" : undefined }} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="bg-slate-50">
                    {head.map((c, ci) => (
                      <th
                        key={ci}
                        className="border-b border-slate-200 px-2.5 py-1.5 font-semibold text-slate-600"
                      >
                        {inlineCode(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((cells, ri) => (
                    <tr key={ri} className="even:bg-slate-50/50">
                      {cells.map((c, ci) => (
                        <td
                          key={ci}
                          className={`border-t border-slate-100 px-2.5 py-1.5 align-top leading-relaxed ${
                            isRef[ci]
                              ? "break-words font-mono text-[10px] text-slate-500"
                              : "text-slate-700"
                          }`}
                        >
                          {inlineCode(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (seg.kind === "exit") {
          const ok = seg.lines[0] === "[exit 0]";
          return (
            <div key={`exit-${i}`} className="pt-1">
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                }`}
              >
                {ok ? "completed" : seg.lines[0].replace(/[[\]]/g, "").replace("exit", "exited")}
              </span>
            </div>
          );
        }
        if (seg.kind === "engine") {
          const t = seg.lines[0];
          const bad = /abort|error|timed out|failed|killed/i.test(t);
          return (
            <p
              key={`eng-${i}-${seg.lines[0].slice(0, 24)}`}
              className={`rounded-md px-2 py-1 text-[11px] ${
                bad ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-500"
              }`}
            >
              {t}
            </p>
          );
        }
        if (seg.kind === "toolgroup") {
          const denials = seg.lines.filter((l) => /denied/i.test(l));
          // summarize WHAT was done, not how many lines it printed:
          // action headers start with ● (copilot) / ⚙ (claude) / X (denied)
          const verbs = new Map<string, number>();
          for (const l of seg.lines) {
            const m = l.match(/^[●⚙Xx✗]\s*([A-Za-z_-]+)/);
            if (m) verbs.set(m[1], (verbs.get(m[1]) ?? 0) + 1);
          }
          const summary =
            [...verbs.entries()].map(([v, n]) => (n > 1 ? `${v} ×${n}` : v)).join(", ") ||
            `${seg.lines.length} line${seg.lines.length === 1 ? "" : "s"}`;
          return (
            <details key={`tool-${i}-${seg.lines[0].slice(0, 24)}`} open={running} className="rounded-lg border border-slate-100 bg-slate-50">
              <summary className="cursor-pointer px-2 py-1 text-[11px] text-slate-400 hover:text-slate-600">
                {<Icon.tool size={12} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} {summary}
                {denials.length > 0 && (
                  <span className="ml-2 rounded-md bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-700">
                    {denials.length} blocked by read-only rules
                  </span>
                )}
              </summary>
              <div className="space-y-0.5 px-2 pb-1.5">
                {seg.lines.map((l, n) => (
                  <p
                    key={n}
                    className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed ${
                      /denied/i.test(l)
                        ? "text-amber-700"
                        : /^[●⚙]/.test(l)
                          ? "font-semibold text-slate-600"
                          : "text-slate-400"
                    }`}
                  >
                    {l}
                  </p>
                ))}
              </div>
            </details>
          );
        }
        return seg.lines.map((t, n) => {
          // task-loop section markers become visual dividers
          const task = t.match(/^━+\s*((?:T|fix)-\d+)\s*\((\d+)\/(\d+)\):\s*(.*?)\s*━*$/);
          if (task) {
            return (
              <div key={`${i}-${n}`} className="mt-2 flex items-center gap-2 border-t border-slate-200 pt-2">
                <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[11px] font-semibold text-white">
                  {task[1]}
                </span>
                <span className="text-xs font-semibold text-slate-700">{task[4]}</span>
                <span className="ml-auto text-[11px] text-slate-400">
                  task {task[2]} of {task[3]}
                </span>
              </div>
            );
          }
          // coverage/traceability verdict lines get status chips
          const cov = t.match(/^\s*((?:REQ|UC|UX)-\w+|\d+\.)\s*[:.\-\s]*(.*?)\s*[-—:]*\s*\b(COVERED|IMPLEMENTED|PARTIAL|MISSING|DIVERGES|SKIPPED)\b(.*)$/i);
          if (cov) {
            const st = cov[3].toUpperCase();
            const chip =
              st === "COVERED" || st === "IMPLEMENTED"
                ? "bg-emerald-100 text-emerald-700"
                : st === "PARTIAL" || st === "SKIPPED"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-red-100 text-red-700";
            return (
              <p key={`${i}-${n}`} className="flex flex-wrap items-baseline gap-1.5 text-xs leading-relaxed text-slate-700">
                <span className="font-mono text-[11px] font-semibold text-slate-500">{cov[1].replace(/\.$/, "")}</span>
                <span>{cov[2]}</span>
                <span className={`rounded-full px-1.5 py-px text-[11px] font-semibold ${chip}`}>{st}</span>
                {cov[4] && <span className="text-slate-500">{cov[4].trim()}</span>}
              </p>
            );
          }
          // long single-paragraph narration reads as a wall - split it into
          // sentence lines (display only; the raw trace keeps the original)
          if (t.length > 280) {
            const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z`])/).filter((x) => x.trim());
            if (sentences.length > 2) {
              return (
                <div key={`${i}-${n}`} className="space-y-1 border-l-2 border-slate-200 pl-2.5">
                  {sentences.map((sn, si) => (
                    <p key={si} className="text-xs leading-relaxed text-slate-700">
                      {inlineCode(sn)}
                    </p>
                  ))}
                </div>
              );
            }
          }
          // A line that LEADS with a file path is the agent reporting an
          // artefact. That is the single most useful thing in a write-doc
          // step and it was buried mid-paragraph - promote it to a file row.
          const artefact = t.match(
            /^\s*[-*]?\s*`?([\w./-]+\.(?:md|cls|trigger|xml|json|js|ts|tsx|html|css|yaml|yml|sql))`?\s*(?:[-–—:]\s*(.*))?$/,
          );
          if (artefact && artefact[1].includes("/")) {
            return (
              <div
                key={`${i}-${n}`}
                className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-1.5"
              >
                <Icon.editor size={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-slate-400" />
                <span className="min-w-0">
                  <span className="block break-all font-mono text-[11px] font-medium text-slate-700">
                    {artefact[1]}
                  </span>
                  {artefact[2] && (
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
                      {inlineCode(artefact[2])}
                    </span>
                  )}
                </span>
              </div>
            );
          }

          // "1. point" - agents number their most important observations
          const numbered = t.match(/^\s*(\d{1,2})[.)]\s+(.*)$/);
          if (numbered) {
            return (
              <p key={`${i}-${n}`} className="flex gap-2 text-xs leading-relaxed text-slate-700">
                <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-md bg-slate-200 text-[10px] font-bold text-slate-600">
                  {numbered[1]}
                </span>
                <span className="min-w-0">{inlineCode(numbered[2])}</span>
              </p>
            );
          }

          // a short ALL-CAPS line is a section heading the agent wrote
          if (/^[A-Z][A-Z0-9 &/()-]{2,40}$/.test(t.trim()) && t.trim().length < 42) {
            return (
              <p
                key={`${i}-${n}`}
                className="pt-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400"
              >
                {t.trim()}
              </p>
            );
          }

          // "- item" / "* item" lines are list items, not prose starting with
          // a hyphen; agents emit markdown lists constantly
          const bullet = t.match(/^\s*[-*•]\s+(.*)$/);
          if (bullet) {
            return (
              <p key={`${i}-${n}`} className="flex gap-1.5 pl-1 text-xs leading-relaxed text-slate-700">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                <span className="min-w-0">{inlineCode(bullet[1])}</span>
              </p>
            );
          }
          // "### Heading" / "## Heading"
          const head = t.match(/^#{2,4}\s+(.*)$/);
          if (head) {
            return (
              <p key={`${i}-${n}`} className="pt-1 text-xs font-semibold text-slate-800">
                {inlineCode(head[1])}
              </p>
            );
          }
          return (
            <p key={`${i}-${n}`} className="text-xs leading-relaxed text-slate-700">
              {inlineCode(t)}
            </p>
          );
        });
  };

  // the view toggle flows WITH the content (top row, right-aligned) - no
  // absolute positioning, no reserved right gutter
  const toggleBtn = (
    <button
      onClick={() => setRaw((v) => !v)}
      className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
        raw
          ? "border-slate-400 bg-slate-700 text-white"
          : "border-slate-200 bg-white text-slate-400 hover:text-slate-600"
      }`}
      title="Toggle between the structured view and the agent's raw trace"
    >
      {raw ? "structured" : "raw trace"}
    </button>
  );
  return (
    <div className="border-t border-slate-100">
      {raw ? (
        <div ref={boxRef} className="max-h-80 overflow-y-auto px-4 py-3">
          <div className="flex items-center">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              Raw agent trace
            </span>
            <span className="ml-auto">{toggleBtn}</span>
          </div>
          <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] text-slate-600">
            {output}
          </pre>
        </div>
      ) : (
    <div className="px-4 py-3">
      {/* two-part header, one body: the selected part fills the full width
          below. Result is selected by default - the activity is evidence you
          open when you want it, not something competing for the same space. */}
      {/* real tabs: each sits in its own raised surface, the selected one
          joins the body below it. An unselected tab still has a visible
          edge and a hover state, so both read as pressable. */}
      <div className="flex items-end gap-1 border-b border-slate-200">
        <button
          onClick={() => setTab("did")}
          aria-pressed={tab === "did"}
          disabled={activitySegs.length === 0}
          className={`-mb-px flex min-w-0 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-[11px] font-medium transition ${
            tab === "did"
              ? "border-slate-200 bg-white text-slate-800"
              : "border-transparent bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-slate-100"
          }`}
          title={did || "no tool activity"}
        >
          <Icon.activity size={12} strokeWidth={1.75} className="shrink-0" />
          <span className="shrink-0">What I did</span>
          {did && <span className="hidden truncate text-slate-400 xl:inline">· {did}</span>}
        </button>

        <button
          onClick={() => setTab("result")}
          aria-pressed={tab === "result"}
          className={`-mb-px flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-[11px] font-medium transition ${
            tab === "result"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-transparent bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
          }`}
        >
          <Icon.ok
            size={12}
            strokeWidth={2}
            className={`shrink-0 ${tab === "result" ? "text-emerald-600" : ""}`}
          />
          <span className="shrink-0">{producedFinal.length > 0 || stated?.summary ? "Outcome" : "Result"}</span>
          {(stated?.summary || producedFinal.length > 0) && (
            <span className="hidden truncate font-normal text-emerald-900/60 lg:inline">
              {stated?.summary || producedFinal.join(" · ")}
            </span>
          )}
        </button>

        <span className="ml-auto hidden shrink-0 items-center pb-1 pl-1 sm:flex">{toggleBtn}</span>
      </div>

      <div
        ref={boxRef}
        className={`max-h-80 space-y-1 overflow-y-auto rounded-b-lg border border-t-0 px-3 py-2.5 ${
          tab === "result"
            ? "border-emerald-200 bg-emerald-50/30"
            : "border-slate-200 bg-white"
        }`}
      >
        {tab === "did" ? (
          activitySegs.map((seg, i) => renderSeg(seg, i))
        ) : (
          <>
            {stated && (stated.summary || stated.produced.length > 0) && (
              <div className="rounded-lg border border-emerald-200 bg-white px-3 py-2">
                {stated.summary && (
                  <p className="text-xs leading-relaxed text-slate-800">{stated.summary}</p>
                )}
                {stated.produced.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {stated.produced.map((x, k) => (
                      <li key={k} className="flex items-start gap-1.5 text-[11px] text-slate-600">
                        <Icon.check
                          size={11}
                          strokeWidth={2.5}
                          className="mt-0.5 shrink-0 text-emerald-600"
                        />
                        <span className="min-w-0">{inlineCode(x)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {stated.confidence && stated.confidence !== "high" && (
                  <p
                    className={`mt-1.5 flex items-start gap-1.5 rounded-md px-2 py-1 text-[11px] ${
                      stated.confidence === "low"
                        ? "bg-red-50 text-red-700"
                        : "bg-amber-50 text-amber-800"
                    }`}
                  >
                    <Icon.warn size={11} strokeWidth={2} className="mt-0.5 shrink-0" />
                    <span>
                      <span className="font-semibold uppercase">{stated.confidence}</span>{" "}
                      confidence{stated.confidenceNote ? ` - ${stated.confidenceNote}` : ""}
                    </span>
                  </p>
                )}
              </div>
            )}
            {!running && (verdict || coverage) && (
              <div
                className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
                  /BLOCKED|INCOMPLETE/i.test((verdict ?? coverage)![0])
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-emerald-200 bg-white text-emerald-700"
                }`}
              >
                {(verdict ?? coverage)![0]}
                {findingsCount > 0 && verdict && (
                  <span className="ml-2 font-normal">· {findingsCount} finding(s) below</span>
                )}
              </div>
            )}
            {postToolSegs.length > 0 && (
              <p className="pb-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-700/70">
                {stated ? "Detail" : "What the agent reported"}
              </p>
            )}
            {[
              ...postToolSegs,
              ...(findingsCount > 0 ? [{ kind: "cards" as const, lines: [] }] : []),
              ...(reqItems.length > 0 ? [{ kind: "reqcards" as const, lines: [] }] : []),
              ...trailingSegs,
            ].map((seg, i) => renderSeg(seg, i))}
          </>
        )}
        {running && (
          <p className="pt-1 text-[11px] text-slate-400">
            <span className="mr-1 inline-block animate-pulse text-sky-500">●</span> working…
          </p>
        )}
      </div>
    </div>
      )}
    </div>
  );
}
