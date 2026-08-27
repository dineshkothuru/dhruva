"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents";
import type { RunState } from "@/lib/workflows/schema";
import { Icon, ROLE_ICON, WF_ICON, wfIconFor, type IconType } from "@/components/icons";
import CliResult from "@/components/workflows/CliResult";
import { loadRoles, saveRoles, rolesFor, type RoleConfig } from "@/lib/roleStore";
import { STEP_ROLES, ROLE_LABEL, ROLE_TIER } from "@/lib/workflows/schema";
import { loadDefaultAgent, saveDefaultAgent } from "@/lib/agentStore";
import { loadCustomModels, addCustomModel } from "@/lib/modelStore";
import WorkflowBuilder, { type BuilderSeed } from "@/components/workflows/WorkflowBuilder";
import RequirementCards, { inlineCode, parseRequirements, ReqBody } from "@/components/workflows/RequirementCards";
import { parseFindings, type Finding } from "@/lib/findings";



/** Workflow identity for catalog cards - same house style as the role cards.
 * Icons are components from the shared vocabulary, so they inherit color and
 * stay optically consistent instead of depending on the OS emoji font. */
const WF_META: Record<string, { icon: IconType; tint: string }> = {
  "bug-fix": { icon: WF_ICON.bug, tint: "bg-red-100 text-red-700" },
  "feature-dev": { icon: WF_ICON.feature, tint: "bg-indigo-100 text-indigo-700" },
  "solution-design": { icon: WF_ICON.design, tint: "bg-indigo-100 text-indigo-700" },
  "ux-design": { icon: WF_ICON.ux, tint: "bg-violet-100 text-violet-700" },
  "implement-tdd": { icon: WF_ICON.build, tint: "bg-slate-200 text-slate-700" },
  "test-gen": { icon: WF_ICON.test, tint: "bg-emerald-100 text-emerald-700" },
  "run-tests": { icon: WF_ICON.run, tint: "bg-emerald-100 text-emerald-700" },
  "retrieve-sync": { icon: WF_ICON.sync, tint: "bg-amber-100 text-amber-700" },
  "deploy-preview": { icon: WF_ICON.preview, tint: "bg-amber-100 text-amber-700" },
  "validate-deploy": { icon: WF_ICON.validate, tint: "bg-amber-100 text-amber-700" },
  "scratch-org": { icon: WF_ICON.scratch, tint: "bg-emerald-100 text-emerald-700" },
};

/** Custom workflows auto-pick a fitting identity from their title/description
 * keywords - deterministic, so the same workflow always gets the same face. */
function wfIdentity(w: { id: string; title: string; description: string }): {
  icon: IconType;
  tint: string;
} {
  const known = WF_META[w.id];
  if (known) return known;
  const icon = wfIconFor(w.id, `${w.title} ${w.description}`);
  const TINT = new Map<IconType, string>([
    [WF_ICON.bug, "bg-red-100 text-red-700"],
    [WF_ICON.deploy, "bg-amber-100 text-amber-700"],
    [WF_ICON.test, "bg-emerald-100 text-emerald-700"],
    [WF_ICON.review, "bg-amber-100 text-amber-700"],
    [WF_ICON.ux, "bg-violet-100 text-violet-700"],
    [WF_ICON.design, "bg-indigo-100 text-indigo-700"],
    [WF_ICON.doc, "bg-sky-100 text-sky-700"],
    [WF_ICON.build, "bg-slate-200 text-slate-700"],
    [WF_ICON.sync, "bg-amber-100 text-amber-700"],
    [WF_ICON.scratch, "bg-emerald-100 text-emerald-700"],
  ]);
  return { icon, tint: TINT.get(icon) ?? "bg-violet-100 text-violet-700" };
}

/** Visual identity per role - icon tile tint, what it means, which steps use it. */
const ROLE_META: Record<string, { icon: IconType; tint: string; blurb: string; steps: string[] }> = {
  read: { icon: ROLE_ICON.read, tint: "bg-sky-100 text-sky-700", blurb: "investigates code and documents before anything changes", steps: ["locate", "plan", "assess"] },
  design: { icon: ROLE_ICON.design, tint: "bg-indigo-100 text-indigo-700", blurb: "authors designs, specs, and documents", steps: ["analyse", "spec", "write-doc"] },
  implement: { icon: ROLE_ICON.implement, tint: "bg-slate-200 text-slate-700", blurb: "writes the code and tests", steps: ["implement"] },
  review: { icon: ROLE_ICON.review, tint: "bg-amber-100 text-amber-700", blurb: "adversarially critiques designs and diffs", steps: ["design-review", "review"] },
  trace: { icon: ROLE_ICON.trace, tint: "bg-emerald-100 text-emerald-700", blurb: "verifies every requirement is covered", steps: ["coverage-check", "traceability"] },
};

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
function FindingCard({ f }: { f: Finding }) {
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

interface CatalogItem {
  id: string;
  title: string;
  description: string;
  custom?: boolean;
  /** custom workflows: where they live - central (all projects) or project. */
  scope?: "central" | "project";
  /** full step list - powers duplicate-to-customize. */
  steps?: Record<string, unknown>[];
  inputs: {
    key: string;
    label: string;
    kind: "text" | "boolean" | "select";
    options?: string[];
    default?: string | boolean;
    attachTo?: boolean;
    hidden?: boolean;
  }[];
}

/** Catalog grouping - anything unlisted lands in the first group. */
const CATEGORIES: [string, string[]][] = [
  ["Development", ["bug-fix", "feature-dev", "solution-design", "ux-design", "implement-tdd"]],
  ["Testing", ["test-gen", "run-tests"]],
  ["Org & deployment", ["retrieve-sync", "deploy-preview", "validate-deploy", "scratch-org"]],
  ["Custom", []],
];

const AGENT_OPTIONS: { id: AgentId; label: string }[] = [
  { id: "copilot", label: "GitHub Copilot" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "OpenAI Codex" },
  { id: "cursor", label: "Cursor" },
];

/** Status face per step. Components, so they inherit the status color and
 * stay aligned with the text beside them. */
const STATUS_ICON: Record<string, IconType> = {
  pending: Icon.pending,
  running: Icon.running,
  waiting_gate: Icon.humanGate,
  done: Icon.ok,
  failed: Icon.failed,
  skipped: Icon.skipped,
};

/** Colored left edge per step status - the run's frontier at a glance. */
const STATUS_EDGE: Record<string, string> = {
  pending: "border-l-slate-200",
  running: "border-l-sky-400",
  waiting_gate: "border-l-amber-400",
  done: "border-l-emerald-400",
  failed: "border-l-red-400",
  skipped: "border-l-slate-200",
};

/** Type chip tint: AI steps stand apart from deterministic ones. */
const TYPE_CHIP: Record<string, string> = {
  agent: "bg-violet-50 text-violet-600",
  gate: "bg-amber-50 text-amber-600",
  verify: "bg-teal-50 text-teal-600",
  cli: "bg-slate-100 text-slate-500",
  snapshot: "bg-slate-100 text-slate-500",
  changes: "bg-slate-100 text-slate-500",
  "tasks-check": "bg-teal-50 text-teal-600",
};

function runCost(r: RunState): number {
  return r.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
}
function fmtCost(c: number): string {
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

/** Structured step-output view: agent narration as prose, tool calls as
 * rows, exit/engine/error lines as badges; auto-follows while streaming. */
function StepBody({
  output,
  type,
  running,
}: {
  output: string;
  type: string;
  running: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  // structured view by default; the toggle shows the untouched raw trace
  const [raw, setRaw] = useState(false);
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

  // verify / changes / streaming cli output stays terminal-style
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
  const showSummary = !running && (did || produced.length > 0);

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
                {produced.length > 0 ? produced.join(" · ") : "no structured output"}
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
          return (
            <div key={`tbl-${i}`} className="my-1.5 overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full border-collapse text-left text-[11px]">
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
                          className="border-t border-slate-100 px-2.5 py-1.5 align-top leading-relaxed text-slate-700"
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
    <div ref={boxRef} className="max-h-80 space-y-1 overflow-y-auto px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
      {!running && (verdict || coverage) && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
            /BLOCKED|INCOMPLETE/i.test((verdict ?? coverage)![0])
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {(verdict ?? coverage)![0]}
          {findingsCount > 0 && verdict && (
            <span className="ml-2 font-normal">· {findingsCount} finding(s) detailed below</span>
          )}
        </div>
      )}
      {activitySegs.length > 0 &&
        (running ? (
          <div className="space-y-1">
            <p className="flex items-center gap-1.5 pb-0.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              <span className="inline-block animate-pulse text-sky-500">●</span>
              Activity - what it is reading and doing
            </p>
            {activitySegs.map((seg, i) => renderSeg(seg, i))}
          </div>
        ) : (
          <details className="group rounded-lg border border-slate-100 bg-slate-50/60">
            <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-slate-500 hover:text-slate-800">
              <Icon.chevron
                size={11}
                strokeWidth={2}
                className="shrink-0 text-slate-400 transition-transform group-open:rotate-90"
              />
              <Icon.activity size={12} strokeWidth={1.75} className="shrink-0 text-slate-400" />
              <span className="font-semibold text-slate-600">What it did</span>
              {did && <span className="truncate text-slate-400">· {did}</span>}
            </summary>
            <div className="space-y-1 border-t border-slate-100 px-2.5 py-2">
              {activitySegs.map((seg, i) => renderSeg(seg, i))}
            </div>
          </details>
        ))}
        </div>
        {toggleBtn}
      </div>
      {/* the answer to "what did it do and what came out" goes FIRST - it was
          previously the last thing after a long transcript */}
      {showSummary && renderSeg({ kind: "summary", lines: [] }, -1)}
      {!running &&
        activitySegs.length > 0 &&
        (postToolSegs.length > 0 || findingsCount > 0 || reqItems.length > 0) && (
          <p className="pt-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
            {<Icon.output size={12} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} Output
          </p>
        )}
      {[
        ...postToolSegs,
        ...(findingsCount > 0 ? [{ kind: "cards" as const, lines: [] }] : []),
        ...(reqItems.length > 0 ? [{ kind: "reqcards" as const, lines: [] }] : []),
        ...trailingSegs,
      ].map((seg, i) => renderSeg(seg, i))}
      {running && (
        <p className="pt-1 text-[11px] text-slate-400">
          <span className="mr-1 inline-block animate-pulse text-sky-500">●</span> working…
        </p>
      )}
    </div>
      )}
    </div>
  );
}

export default function WorkflowsPane({
  root,
  onOpenDiff,
  jumpToRun,
  onJumpConsumed,
}: {
  root: string;
  onOpenDiff?: (rel: string, pin?: { base?: string; end?: string }) => void;
  /** Run id to open on arrival (a run started from the chat intake). */
  jumpToRun?: string | null;
  /** Called once the jump target is opened, so it never re-fires. */
  onJumpConsumed?: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [inputs, setInputs] = useState<Record<string, string | boolean>>({});
  const [agent, setAgent] = useState<AgentId>(() => loadDefaultAgent() ?? "claude");
  const [defaultAgent, setDefaultAgent] = useState<AgentId | null>(() => loadDefaultAgent());
  const [roleTab, setRoleTab] = useState<AgentId>(() => loadDefaultAgent() ?? "claude");
  const [run, setRun] = useState<RunState | null>(null);
  const [history, setHistory] = useState<RunState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gateNote, setGateNote] = useState("");
  const [gating, setGating] = useState(false);
  // per-step failure diagnosis (streamed from the agent, read-only)
  const [explain, setExplain] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<string | null>(null);

  async function explainFailure(rawStepId: string, stepTitle: string, output: string) {
    const stepId = `${run?.runId}:${rawStepId}`;
    if (explaining) return;
    setExplaining(stepId);
    setExplain((e) => ({ ...e, [stepId]: "" }));
    try {
      const prompt =
        `A step in a Salesforce delivery workflow failed. Diagnose it. DO NOT modify any files.\n` +
        `Workflow: ${run?.workflowTitle}\nStep: ${stepTitle}\n` +
        `Step output (tail):\n${output.slice(-4000)}\n\n` +
        `Reply with: (1) the root cause in plain language, (2) the exact resolution - ` +
        `commands to run, Setup paths, or what to change - for a Salesforce developer, ` +
        `(3) whether re-running the workflow will then succeed. Be brief and concrete.`;
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, agent, prompt, model: "", readOnly: true }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text();
        setExplain((e) => ({ ...e, [stepId]: `could not diagnose: ${err || res.status}` }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) setExplain((e) => ({ ...e, [stepId]: (e[stepId] ?? "") + chunk }));
      }
      const tail = decoder.decode();
      if (tail) setExplain((e) => ({ ...e, [stepId]: (e[stepId] ?? "") + tail }));
    } catch (err) {
      setExplain((e) => ({ ...e, [stepId]: String(err) }));
    } finally {
      setExplaining(null);
    }
  }
  const [starting, setStarting] = useState(false);
  // monotonically increasing sequence: stale state responses are dropped so a
  // slow poll can never overwrite a fresher post-gate state
  const stateSeq = useRef(0);

  const [roleCfg, setRoleCfg] = useState<Record<string, RoleConfig>>({});
  const [status, setStatus] = useState<Record<
    string,
    { installed?: boolean; tiers?: Record<string, string>; models?: { id: string; label: string }[] }
  > | null>(null);
  const [designing, setDesigning] = useState(false);
  // duplicate-to-customize: the workflow the builder is seeded from
  const [seed, setSeed] = useState<CatalogItem | null>(null);
  const [runFilter, setRunFilter] = useState("");

  /** Filter runs by anything a human would search on: title, status, agent,
   * model, run id, date text, and the run's input content. */
  function matchesFilter(r: RunState): boolean {
    const q = runFilter.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      r.workflowTitle,
      r.status,
      r.agent,
      r.model ?? "",
      r.runId,
      new Date(r.createdAt).toLocaleString(),
      new Date(r.createdAt).toISOString().slice(0, 10),
      ...Object.values(r.inputs ?? {}).map(String),
    ]
      .join(" ")
      .toLowerCase();
    return q.split(/\s+/).every((term) => hay.includes(term));
  }
  // files attached in the start modal - ride into the run's text inputs so
  // agent steps read them (the engine's full-read rule applies)
  const [attachments, setAttachments] = useState<{ rel: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, 8)) {
        const fd = new FormData();
        fd.append("root", root);
        fd.append("file", f);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (res.ok) setAttachments((a) => [...a, { rel: String(data.rel), name: String(data.name) }]);
        else setError(String(data.error ?? "upload failed"));
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function refreshCatalog() {
    const { ok, data } = await api({ action: "list", root });
    if (ok) setCatalog(data.workflows as CatalogItem[]);
  }
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const api = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch("/api/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: `unexpected response (HTTP ${res.status})` };
    }
    return { ok: res.ok, data };
  }, []);

  async function fetchRunState(runId: string) {
    const seq = ++stateSeq.current;
    const { ok, data } = await api({ action: "state", runId });
    if (ok && seq === stateSeq.current) setRun(data as unknown as RunState);
  }

  /** Open any run by id - live runs come from engine memory; finished runs
   * that only exist on disk come from the runs listing. Used by the chain
   * rail to hop between a chain's phases. */
  async function openRunById(runId: string) {
    const seq = ++stateSeq.current;
    const { ok, data } = await api({ action: "state", runId });
    if (ok) {
      if (seq === stateSeq.current) setRun(data as unknown as RunState);
      return;
    }
    const r = await api({ action: "runs", root });
    if (r.ok && seq === stateSeq.current) {
      const found = ((r.data.runs as RunState[]) ?? []).find((x) => x.runId === runId);
      if (found) setRun(found);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) setRoleCfg(loadRoles());
      fetch("/api/agent-status")
        .then((r) => r.json())
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {});
      const { ok, data } = await api({ action: "list", root });
      if (!cancelled && ok) setCatalog(data.workflows as CatalogItem[]);
      const runsRes = await api({ action: "runs", root });
      if (!cancelled && runsRes.ok) setHistory((runsRes.data.runs as RunState[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, root]);

  // a run started from the chat intake opens directly (consumed exactly once)
  useEffect(() => {
    if (!jumpToRun) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await fetchRunState(jumpToRun);
      onJumpConsumed?.();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, jumpToRun]);

  // poll the active run
  useEffect(() => {
    if (!run || run.status === "done" || run.status === "failed" || run.status === "aborted") {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => {
      void fetchRunState(run.runId);
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // fetchRunState is stable in behavior (api is memoized; seq is a ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, run]);

  function pick(w: CatalogItem) {
    setSelected(w);
    setError(null);
    const init: Record<string, string | boolean> = {};
    for (const i of w.inputs)
      init[i.key] =
        i.default ?? (i.kind === "boolean" ? false : i.kind === "select" ? (i.options?.[0] ?? "") : "");
    setInputs(init);
  }

  /** The input the attach button lives on (and where file refs are appended). */
  function isAttachTarget(i: { key: string; kind: string; attachTo?: boolean }): boolean {
    if (!selected) return false;
    const target =
      selected.inputs.find((x) => x.attachTo) ?? selected.inputs.find((x) => x.kind === "text");
    return target?.key === i.key;
  }

  async function start() {
    if (!selected || starting) return;
    setStarting(true);
    setError(null);
    try {
      // append attached files to the workflow's designated free-text input
      // (attachTo), never to path/list fields; fallback: first text input
      const startInputs = { ...inputs };
      if (attachments.length > 0) {
        const target =
          selected.inputs.find((i) => i.attachTo) ??
          selected.inputs.find((i) => i.kind === "text");
        if (target) {
          startInputs[target.key] =
            `${String(startInputs[target.key] ?? "")}\n\nAttached files (read them from the project root): ${attachments.map((a) => a.rel).join(", ")}`;
        }
      }
      const { ok, data } = await api({
        action: "start",
        root,
        workflow: selected.id,
        inputs: startInputs,
        agent,
        roleModels: rolesFor(agent),
      });
      if (!ok) {
        setError(String(data.error ?? "could not start"));
        return;
      }
      await fetchRunState(String(data.runId));
      setSelected(null);
      setAttachments([]);
    } finally {
      setStarting(false);
    }
  }

  async function gate(decision: "approve" | "abort" | "revise", feedback?: string) {
    if (!run || gating) return;
    setGating(true);
    try {
      const { ok, data } = await api({ action: "gate", runId: run.runId, decision, feedback });
      if (ok && data.resolved === false) {
        alert("The gate is not waiting right now (a revision is replaying or the run ended) - your click was not applied. The view will refresh.");
      }
      setGateNote("");
      await fetchRunState(run.runId);
    } finally {
      setGating(false);
    }
  }

  // ---------- run view ----------
  if (run) {
    const totalIn = run.steps.reduce((n, s) => n + (s.usage?.inTokens ?? 0), 0);
    const totalOut = run.steps.reduce((n, s) => n + (s.usage?.outTokens ?? 0), 0);
    const totalCost = run.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={async () => {
              setRun(null);
              const r = await api({ action: "runs", root });
              if (r.ok) setHistory((r.data.runs as RunState[]) ?? []);
            }}
            className="text-xs text-slate-500 hover:underline"
          >
            ← workflows
          </button>
          <h2 className="text-sm font-semibold">{run.workflowTitle}</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
              run.status === "done"
                ? "bg-emerald-100 text-emerald-700"
                : run.status === "failed" || run.status === "aborted"
                  ? "bg-red-100 text-red-700"
                  : "bg-sky-100 text-sky-700"
            }`}
          >
            <span className={`mr-1 inline-flex h-1.5 w-1.5 rounded-full ${run.status === "running" ? "animate-pulse bg-sky-500" : run.status === "waiting_gate" ? "animate-pulse bg-amber-500" : run.status === "done" ? "bg-emerald-500" : "bg-red-400"}`} />{run.status.replace("_", " ")}
          </span>
          {run.autoGate && (
            <span
              className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-700"
              title="Unattended mode: an AI gatekeeper clears the human gates (every decision + reasoning is recorded in the gate's log) and escalates to you only when unsure"
            >
              {<Icon.robot size={12} strokeWidth={1.75} className="inline shrink-0 text-violet-500" />} unattended
            </span>
          )}
          <span className="ml-auto font-mono text-[11px] text-slate-400">run {run.runId}</span>
          {(run.status === "running" || run.status === "waiting_gate") && (
            <button
              onClick={async () => {
                if (!confirm("Stop this run? The current step is killed and remaining steps are skipped.")) return;
                await api({ action: "stop", runId: run.runId });
                await fetchRunState(run.runId);
              }}
              className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-600 hover:bg-red-100"
              title="Abort the run - kills the running step's process"
            >
              ■ Stop run
            </button>
          )}
          {(run.status === "failed" || run.status === "aborted") && (
            <button
              onClick={async () => {
                const { ok, data } = await api({
                  action: "resume",
                  root,
                  runId: run.runId,
                  roleModels: rolesFor(run.agent),
                });
                if (!ok) alert(String(data.error ?? "cannot resume"));
                else await fetchRunState(run.runId);
              }}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
              title="Re-run from the first incomplete step - completed steps and approved gates are kept"
            >
              ⟳ Resume run
            </button>
          )}
        </div>
        <p className="mb-3 text-[11px] text-slate-500">
          <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium">
            {run.agent}
            {run.model ? ` · ${run.model}` : " · default model"}
          </span>
          {totalIn + totalOut > 0 && (
            <>
              {totalIn.toLocaleString()} in / {totalOut.toLocaleString()} out tokens ·{" "}
              {totalCost < 0.01 ? `$${totalCost.toFixed(4)}` : `$${totalCost.toFixed(2)}`} at API
              rates (runs on your subscription - not billed)
            </>
          )}
        </p>

        {run.chain && run.chain.length > 1 && (
          <div className="mb-3 rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50/70 via-white to-white px-3.5 py-2.5">
            <div className="flex items-center gap-2 overflow-x-auto">
              <span className="shrink-0 text-[11px] font-bold uppercase tracking-widest text-indigo-400">
                {<Icon.chain size={12} strokeWidth={1.75} className="inline shrink-0 text-indigo-400" />} Chain
              </span>
              {run.chain.map((c, ci) => {
                const idx = run.chainIndex ?? 0;
                const live = run.status === "running" || run.status === "waiting_gate";
                const state =
                  ci < idx ? "done" : ci === idx ? "current" : c.runId ? "started" : "queued";
                const clickable = !!c.runId && c.runId !== run.runId;
                return (
                  <span key={ci} className="flex shrink-0 items-center gap-2">
                    {ci > 0 && (
                      <span
                        className={`text-sm ${
                          ci === idx + 1 && live ? "animate-pulse text-indigo-400" : "text-slate-300"
                        }`}
                        title="starts automatically after a clean finish"
                      >
                        →
                      </span>
                    )}
                    <button
                      onClick={() => clickable && void openRunById(c.runId!)}
                      disabled={!clickable}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                        state === "done"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400"
                          : state === "current"
                            ? "border-indigo-500 bg-indigo-600 text-white shadow-sm"
                            : state === "started"
                              ? "animate-pulse border-sky-300 bg-sky-50 text-sky-700 hover:border-sky-500"
                              : "border-dashed border-slate-300 bg-white text-slate-400"
                      } ${clickable ? "" : "cursor-default"}`}
                      title={
                        state === "done"
                          ? "finished - open this phase's run"
                          : state === "started"
                            ? "running now - open the live run"
                            : state === "current"
                              ? "this run"
                              : "queued - starts after the previous phase finishes clean"
                      }
                    >
                      {(() => {
                        const I =
                          state === "done"
                            ? Icon.check
                            : state === "current"
                              ? live
                                ? Icon.running
                                : run.status === "done"
                                  ? Icon.check
                                  : Icon.stop
                              : state === "started"
                                ? Icon.run
                                : Icon.pending;
                        return (
                          <I
                            size={11}
                            strokeWidth={2.25}
                            className={state === "current" && live ? "animate-pulse" : ""}
                          />
                        );
                      })()}
                      {c.title}
                      {state === "started" && (
                        <span className="text-[11px] font-semibold uppercase">live</span>
                      )}
                    </button>
                  </span>
                );
              })}
              <span className="ml-auto hidden shrink-0 pl-3 text-[11px] text-slate-400 lg:inline">
                phase {(run.chainIndex ?? 0) + 1} of {run.chain.length} · the next phase
                auto-starts on a clean finish; fail or abort pauses the chain
              </span>
            </div>
          </div>
        )}

        {(run.manualSteps?.length ?? 0) > 0 && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-amber-700">
              {<Icon.humanGate size={12} strokeWidth={1.75} className="inline shrink-0 text-amber-600" />} Manual steps for a human · {run.manualSteps!.length}
              {run.chain && run.chain.length > 1 && (
                <span className="font-medium normal-case tracking-normal text-amber-600">
                  (collected across the chain&apos;s phases)
                </span>
              )}
            </p>
            <p className="mt-1 text-[11px] text-amber-700/80">
              The agents flagged these as actions they cannot perform from this machine - do them
              in the org yourself.
            </p>
            <ol className="mt-2 space-y-1.5">
              {run.manualSteps!.map((m, mi) => (
                <li key={mi} className="flex items-start gap-2 text-xs text-amber-900">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[11px] font-bold text-amber-800">
                    {mi + 1}
                  </span>
                  <span className="min-w-0">
                    {m.text}
                    <span className="ml-1.5 rounded-md bg-white/70 px-1.5 py-px text-[11px] font-medium text-amber-600">
                      {m.phase && m.phase !== run.workflowTitle ? `${m.phase} · ` : ""}
                      {m.stepId}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {Object.keys(run.inputs ?? {}).length > 0 && (
          <details className="mb-3 rounded-xl border border-slate-200 bg-white">
            <summary className="cursor-pointer px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-slate-400 hover:text-slate-700">
              {<Icon.inputs size={12} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} Run inputs - what this run was asked to do
            </summary>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 border-t border-slate-100 px-4 py-3 sm:grid-cols-2 xl:grid-cols-3">
              {Object.entries(run.inputs).map(([k, v]) => {
                const val = typeof v === "boolean" ? (v ? "yes" : "no") : String(v).slice(0, 2000);
                const long = val.length > 90 || val.includes("\n");
                return (
                  <div key={k} className={long ? "sm:col-span-2 xl:col-span-3" : ""}>
                    <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{k}</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">
                      {val || <span className="text-slate-300">empty</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </details>
        )}
        {/* the journey at a glance: where the run is, what's left, where the
            human comes in (gates marked). Pure render - zero tokens. */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-y-2">
            {run.steps.map((s, i) => (
              <span key={s.id} className="flex items-center">
                {i > 0 && <span className="mx-1 h-px w-3 bg-slate-200" />}
                <span
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    s.status === "done"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : s.status === "running"
                        ? "border-sky-300 bg-sky-50 text-sky-700 ring-2 ring-sky-100"
                        : s.status === "waiting_gate"
                          ? "border-amber-300 bg-amber-50 text-amber-700 ring-2 ring-amber-100"
                          : s.status === "failed"
                            ? "border-red-200 bg-red-50 text-red-600"
                            : s.status === "skipped"
                              ? "border-slate-100 bg-slate-50 text-slate-300 line-through"
                              : "border-slate-200 bg-white text-slate-400"
                  }`}
                  title={`${s.title} (${s.type}) - ${s.status}`}
                >
                  {(() => {
                    const I =
                      s.type === "gate"
                        ? Icon.humanGate
                        : s.status === "done"
                          ? Icon.check
                          : s.status === "failed"
                            ? Icon.failed
                            : s.status === "running"
                              ? Icon.running
                              : Icon.pending;
                    return <I size={11} strokeWidth={2} className={s.status === "running" ? "animate-pulse" : ""} />;
                  })()}
                  <span className="max-w-24 truncate">{s.id}</span>
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            {(() => {
              const cur = run.steps.find((s) => s.status === "running" || s.status === "waiting_gate");
              const doneN = run.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
              if (run.status === "done") return "Run complete - every step finished.";
              if (run.status === "failed" || run.status === "aborted")
                return "Run stopped - use Resume to continue from the first incomplete step.";
              if (cur?.status === "waiting_gate")
        return ` YOUR decision: "${cur.title}" - the run is paused until you act (${doneN}/${run.steps.length} steps done).`;
       if (cur) return `Working: "${cur.title}" (${doneN}/${run.steps.length} steps done). marks where you decide.`;
              return `${doneN}/${run.steps.length} steps done.`;
            })()}
          </p>
        </div>

        <div className="space-y-2">
          {run.steps.map((s) => (
            <details
              key={s.id}
              open={s.status === "running" || s.status === "waiting_gate" || s.status === "failed"}
              className={`rounded-xl border border-l-4 transition-shadow ${
                STATUS_EDGE[s.status] ?? "border-l-slate-200"
              } ${
                s.status === "waiting_gate"
                  ? "border-amber-300 bg-white ring-1 ring-amber-200 shadow-lg shadow-amber-100/70"
                  : s.status === "pending"
                    ? "border-slate-200 bg-slate-50/60"
                    : "border-slate-200 bg-white shadow-sm"
              }`}
            >
              <summary
                className={`flex items-center gap-2 px-4 py-2.5 text-sm ${
                  s.status === "pending" ? "cursor-default list-none" : "cursor-pointer"
                }`}
              >
                {(() => {
                  const I = STATUS_ICON[s.status] ?? Icon.pending;
                  const tone =
                    s.status === "done"
                      ? "text-emerald-600"
                      : s.status === "failed"
                        ? "text-red-500"
                        : s.status === "waiting_gate"
                          ? "text-amber-500"
                          : s.status === "running"
                            ? "text-sky-500 animate-pulse"
                            : "text-slate-300";
                  return <I size={15} strokeWidth={2} className={`shrink-0 ${tone}`} />;
                })()}
                <span className="min-w-0 flex-1">
                  <span
                    className={
                      s.status === "skipped"
                        ? "text-slate-400 line-through"
                        : s.status === "pending"
                          ? "text-slate-400"
                          : "font-medium text-slate-800"
                    }
                  >
                    {s.title}
                  </span>
                  {/* a step that has not run yet says so, instead of being an
                      unexplained empty row */}
                  {s.status === "pending" && (
                    <span className="ml-2 text-[11px] text-slate-300">not started</span>
                  )}
                  {s.status === "skipped" && (
                    <span className="ml-2 text-[11px] text-slate-400">skipped</span>
                  )}
                  {s.startedAt && s.endedAt && s.status !== "pending" && (
                    <span className="ml-2 text-[11px] text-slate-400">
                      {(() => {
                        const sec = Math.round((s.endedAt - s.startedAt) / 1000);
                        return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
                      })()}
                    </span>
                  )}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {s.type === "agent" && s.model && s.model !== "default" && (
                    <span
                      className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-500"
                      title={s.modelFrom ? `model source: ${s.modelFrom}` : undefined}
                    >
                      {s.model}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                      TYPE_CHIP[s.type] ?? "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {s.type}
                  </span>
                </span>
              </summary>
              {s.status === "waiting_gate" ? (
                <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="whitespace-pre-wrap text-sm text-amber-800">{s.output}</p>
                  {(() => {
                    // the reviewer's UNRESOLVED objections belong AT the gate -
                    // the human decides against them, so show them here. Search
                    // only the steps SINCE THE PREVIOUS GATE: earlier phases'
                    // blocked reviews were already ruled on at their own gate.
                    const gateIdx = run.steps.findIndex((x) => x.id === s.id);
                    let prevGateIdx = -1;
                    for (let k = gateIdx - 1; k >= 0; k--) {
                      if (run.steps[k].type === "gate") {
                        prevGateIdx = k;
                        break;
                      }
                    }
                    const segment = run.steps.slice(prevGateIdx + 1, gateIdx);
                    const reviewer = [...segment]
                      .reverse()
                      .find((x) => x.type === "agent" && /VERDICT:\s*BLOCKED/i.test(x.output));
                    if (!reviewer) return null;
                    const fm = reviewer.output.match(/\*{0,2}F\d+[\s:(]/);
                    const findings = fm
                      ? reviewer.output.slice(fm.index)
                      : reviewer.output.slice(-3000);
                    const gateParsed = parseFindings(findings);
                    return (
                      <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-red-600">
                          Reviewer findings - still BLOCKED after the auto-fix round
                        </p>
                        {gateParsed.findings.length > 0 ? (
                          <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
                            {gateParsed.findings.map((f, fi) => (
                              <FindingCard key={`${f.id}-${fi}`} f={f} />
                            ))}
                          </div>
                        ) : (
                          <pre className="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-white/60 p-2 text-xs text-slate-700">
                            {findings}
                          </pre>
                        )}
                        <button
                          onClick={() =>
                            gate(
                              "revise",
                              `Address EVERY blocking finding from the design reviewer, exactly as each Fix line specifies. Do not re-argue a finding - implement its fix or state explicitly why it is impossible:\n\n${findings.slice(0, 11000)}`,
                            )
                          }
                          disabled={gating}
                          className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                        >
                          ⟳ Revise with ALL findings
                        </button>
                      </div>
                    );
                  })()}
                  {(() => {
                    // itemized review: if a step SINCE THE PREVIOUS GATE
                    // produced REQ blocks, render per-requirement cards -
                    // never resurrect an earlier phase's cards at later gates
                    // (approving them there would masquerade as a design review)
                    const gateIdx = run.steps.findIndex((x) => x.id === s.id);
                    let prevGateIdx = -1;
                    for (let k = gateIdx - 1; k >= 0; k--) {
                      if (run.steps[k].type === "gate") {
                        prevGateIdx = k;
                        break;
                      }
                    }
                    const segment = run.steps.slice(prevGateIdx + 1, gateIdx);
                    const source = [...segment]
                      .reverse()
                      .find((x) => x.type === "agent" && x.output.includes("### REQ-"));
                    if (!source) return null;
                    const items = parseRequirements(source.output);
                    if (items.length === 0) return null;
                    // map reviewer findings to the REQ ids they mention, so
                    // each card shows WHY the critic objected to it
                    const reviewer = [...segment]
                      .reverse()
                      .find((x) => x.type === "agent" && /VERDICT:\s*BLOCKED/i.test(x.output));
                    const critique: Record<string, string[]> = {};
                    if (reviewer) {
                      const parts = reviewer.output.split(/(?=\*{0,2}F\d+[\s:(])/);
                      for (const p of parts) {
                        // new format: "F1 (critical) [refs: REQ-007]: title"
                        const neu = p.match(
                          /^\*{0,2}(F\d+)\s*\((critical|important|nit)\)\s*\[refs:\s*([^\]]*)\]\s*:\s*(.{0,300}?)(?:\n|\*\*|$)/s,
                        );
                        // legacy format: "F1: title (critical)"
                        const old = neu
                          ? null
                          : p.match(/^\*{0,2}(F\d+):\s*(.{0,300}?)\s*\((critical|important|nit)\)/s);
                        if (!neu && !old) continue;
                        const id = neu ? neu[1] : old![1];
                        const sev = neu ? neu[2] : old![3];
                        const title = (neu ? neu[4] : old![2]).replace(/\*+/g, "").trim();
                        const problem =
                          p.match(/Problem:\s*([\s\S]{0,300}?)(?:\n\s*Fix:|$)/)?.[1]?.trim() ?? "";
                        const text = `${id} (${sev}): ${title} - ${problem}`;
                        // refs come from the declared [refs:] list when present,
                        // else fall back to scanning the finding body
                        const refs = neu
                          ? (neu[3].match(/(?:REQ|UX|T)-\d+/g) ?? [])
                          : (p.match(/REQ-\d+/g) ?? []);
                        for (const reqId of new Set(refs)) {
                          (critique[reqId] ??= []).push(text);
                        }
                      }
                    }
                    return (
                      <RequirementCards
                        items={items}
                        critique={critique}
                        disabled={gating}
                        onApproveAll={() => gate("approve")}
                        onSubmit={(instruction) => gate("revise", instruction)}
                      />
                    );
                  })()}
                  <textarea
                    value={gateNote}
                    onChange={(e) => setGateNote(e.target.value)}
                    rows={2}
                    placeholder="Optional instructions - e.g. 'use a flow instead of a trigger', 'split the service class'. Filling this enables Revise: the previous analysis re-runs following your instructions, then gates again."
                    className="mt-3 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs outline-none focus:border-amber-400"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => gate("approve")}
                      disabled={gating}
                      className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                    >
                      {gating ? "…" : "Approve & continue"}
                    </button>
                    <button
                      onClick={() => gate("revise", gateNote)}
                      disabled={gating || !gateNote.trim()}
                      className="rounded-lg border border-amber-400 bg-white px-4 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-40"
                      title="Re-run the analysis with your instructions, then review again"
                    >
                      Revise with instructions
                    </button>
                    <button
                      onClick={() => gate("abort")}
                      disabled={gating}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
                    >
                      Abort run
                    </button>
                  </div>
                </div>
              ) : (
                <StepBody
                  output={s.output}
                  type={s.type}
                  // never show "working…" unless the RUN itself is still live
                  running={
                    s.status === "running" &&
                    (run.status === "running" || run.status === "waiting_gate")
                  }
                />
              )}
              {s.status === "failed" && s.output && (
                <div className="border-t border-slate-100 px-4 py-2">
                  {explain[`${run.runId}:${s.id}`] === undefined ? (
                    <button
                      onClick={() => explainFailure(s.id, s.title, s.output)}
                      disabled={explaining !== null}
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                    >
           {explaining === `${run.runId}:${s.id}` ? "Diagnosing…" : " Explain & suggest fix"}
                    </button>
                  ) : (
                    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sky-600">
                        Diagnosis ({agent})
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-xs text-slate-700">
                        {explain[`${run.runId}:${s.id}`] || "analysing…"}
                      </pre>
                    </div>
                  )}
                </div>
              )}
              {s.usage && (
                <p className="border-t border-slate-100 px-4 py-1.5 text-[11px] text-slate-400">
                  {s.model && (
                    <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5" title={s.modelFrom ? `model source: ${s.modelFrom}` : undefined}>
                      {s.model}
                      {s.modelFrom && <span className="ml-1 text-slate-400">· {s.modelFrom}</span>}
                    </span>
                  )}
                  {s.usage.estimated ? "~" : ""}
                  {s.usage.inTokens.toLocaleString()} in / {s.usage.outTokens.toLocaleString()} out
                  tokens · $
                  {s.usage.costUsd < 0.01 ? s.usage.costUsd.toFixed(4) : s.usage.costUsd.toFixed(2)}{" "}
                  {s.usage.estimated ? "(est. at API rates)" : "(reported by the agent)"}
                </p>
              )}
              {s.id === "changes" && run.changes && run.changes.length > 0 && (
                <div className="border-t border-slate-100 px-4 py-2">
                  {!run.baseCommit && (
                    <p className="mb-1.5 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
                      <Icon.warn size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                      This run has no pinned commits, so its diffs cannot be replayed. Opening a
                      file compares it against the latest snapshot instead.
                    </p>
                  )}
                  {run.changes.map((c) => (
                    <button
                      key={c.file}
                      onClick={() =>
                        onOpenDiff?.(
                          c.file,
                          run.baseCommit
                            ? { base: run.baseCommit, end: run.endCommit }
                            : undefined,
                        )
                      }
                      className="block w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-slate-100"
                      title="Open diff"
                    >
                      <span className="mr-2 text-[11px] font-semibold uppercase text-amber-600">
                        {c.status}
                      </span>
                      {c.file}
                    </button>
                  ))}
                </div>
              )}
            </details>
          ))}
        </div>

      </div>
    );
  }

  // ---------- catalog + start form ----------
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-base font-semibold tracking-tight text-slate-800">Delivery workflows</h2>
      <div className="mt-1.5 h-0.5 w-10 rounded-full bg-gradient-to-r from-indigo-500 to-sky-400" />
      <p className="mt-1 text-xs text-slate-500">
        Deterministic step-by-step paths. Agents act only inside gated steps; everything is logged
        to the run history.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <details className="mt-4 rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-800">
          {<Icon.models size={12} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} Models by role - which model plays each role, per agent
        </summary>
        <div className="space-y-4 border-t border-slate-100 p-4">
          <p className="text-[11px] text-slate-400">
            Every workflow step plays one of five roles; set the model per role once and every
            workflow follows - no per-run input needed. Empty = automatic (the shipped default
            shown as placeholder). A change here applies from the next run.
          </p>
          <div className="flex gap-1.5">
            {AGENT_OPTIONS.map((a) => (
              <button
                key={a.id}
                onClick={() => setRoleTab(a.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  roleTab === a.id
                    ? "border-slate-900 bg-slate-900 text-white"
                    : defaultAgent === a.id
                      ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                }`}
              >
                {a.label}
                {defaultAgent === a.id && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px]"><Icon.star size={10} strokeWidth={2} className="fill-current" /> default</span>}
              </button>
            ))}
          </div>
          {(() => {
            const s = status?.[roleTab];
            const cfg = roleCfg[roleTab] ?? {};
            return (
              <div>
                <datalist id={`models-${roleTab}`}>
                  {[
                    ...(s?.models ?? []).map((m) => m.id).filter(Boolean),
                    ...loadCustomModels(roleTab),
                  ].map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
                <label className="flex w-fit cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
                  <input
                    type="checkbox"
                    checked={defaultAgent === roleTab}
                    onChange={(e) => {
                      const v = e.target.checked ? roleTab : null;
                      saveDefaultAgent(v);
                      setDefaultAgent(v);
                      if (v) setAgent(v);
                    }}
                  />
                  Default agent - preselected for chat and every new run
                </label>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {STEP_ROLES.map((role) => {
                    const val = cfg[role]?.trim() ?? "";
                    const set = !!val;
                    const invalid = set && !/^[A-Za-z0-9._-]{1,60}$/.test(val);
                    const rm = ROLE_META[role];
                    const autoModel = s?.tiers?.[ROLE_TIER[role]] || "cli default";
                    return (
                      <div key={role} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md">
                        <div className="flex items-center gap-2">
                          <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${rm.tint}`}>
                            <rm.icon size={14} strokeWidth={1.75} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-800">{ROLE_LABEL[role]}</p>
                            <p className="truncate text-[11px] text-slate-400">{rm.blurb}</p>
                          </div>
                        </div>
                        <input
                          value={cfg[role] ?? ""}
                          list={`models-${roleTab}`}
                          onChange={(e) => {
                            const all = loadRoles();
                            all[roleTab] = { ...all[roleTab], [role]: e.target.value.trim() };
                            saveRoles(all);
                            setRoleCfg(all);
                          }}
                          onBlur={(e) => {
                            let v = e.target.value.trim();
                            const known = [...(s?.models ?? []).map((m) => m.id), ...loadCustomModels(roleTab)].filter(Boolean);
                            const match = known.find((id) => id.toLowerCase() === v.toLowerCase() && id !== v);
                            if (match) {
                              v = match;
                              const all = loadRoles();
                              all[roleTab] = { ...all[roleTab], [role]: v };
                              saveRoles(all);
                              setRoleCfg(all);
                            }
                            if (v && !known.includes(v)) addCustomModel(roleTab, v);
                          }}
                          placeholder={autoModel}
                          spellCheck={false}
                          className={`mt-2.5 block w-full rounded-lg border px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-slate-400 ${
                            invalid ? "border-red-400 bg-red-50/50" : set ? "border-sky-200 bg-sky-50/40" : "border-slate-200"
                          }`}
                        />
                        <p className="mt-1 text-[11px] text-slate-400">
                          {invalid ? (
                            <span className="font-semibold text-red-600">not a model id (no spaces) - would be IGNORED</span>
                          ) : set ? (
                            <span className="text-sky-600">your setting</span>
                          ) : (
                            <>auto · {autoModel}</>
                          )}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1 border-t border-slate-100 pt-1.5">
                          {rm.steps.map((st) => (
                            <span key={st} className="rounded-md bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-500">{st}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        </div>
      </details>

      {history.length > 0 && (
        <details className="mt-4 rounded-xl border border-slate-200 bg-white">
          <summary className="flex cursor-pointer items-center px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-800">
            {<Icon.history size={12} strokeWidth={1.75} className="inline shrink-0 text-slate-400" />} Recent runs ({history.length})
            <span className="ml-auto font-normal normal-case tracking-normal text-slate-400">
              total {fmtCost(history.reduce((n, r) => n + runCost(r), 0))} at API rates
            </span>
          </summary>
          <div className="space-y-1 border-t border-slate-100 p-3">
            <input
              value={runFilter}
              onChange={(e) => setRunFilter(e.target.value)}
              placeholder="Filter runs - text, status, agent, date (e.g. 2026-08-26), or words from the request…"
              spellCheck={false}
              className="mb-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
            />
            {history.filter(matchesFilter).length === 0 && (
              <p className="px-2 py-1 text-xs text-slate-400">no runs match</p>
            )}
            {history.filter(matchesFilter).map((r) => (
              <button
                key={r.runId}
                onClick={() => setRun(r)}
                className={`flex w-full items-center gap-3 rounded-lg border border-l-4 border-slate-200 bg-white px-3 py-2 text-left text-xs hover:border-slate-400 ${
                  r.status === "done"
                    ? "border-l-emerald-400"
                    : r.status === "running" || r.status === "waiting_gate"
                      ? "border-l-sky-400"
                      : "border-l-red-300"
                }`}
              >
                <span className="font-medium">{r.workflowTitle}</span>
                {r.chain && r.chain.length > 1 && (
                  <span
                    className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-500"
                    title={`chain: ${r.chain.map((c) => c.title).join(" → ")}`}
                  >
                    {<Icon.chain size={12} strokeWidth={1.75} className="inline shrink-0 text-indigo-400" />} {(r.chainIndex ?? 0) + 1}/{r.chain.length}
                  </span>
                )}
                <span className="text-slate-400">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                  {r.agent}
                  {r.model ? ` · ${r.model}` : ""}
                </span>
                {runCost(r) > 0 && (
                  <span className="text-[11px] text-slate-400">{fmtCost(runCost(r))}</span>
                )}
                <span
                  className={`ml-auto text-[11px] font-semibold uppercase ${
                    r.status === "done"
                      ? "text-emerald-600"
                      : r.status === "running" || r.status === "waiting_gate"
                        ? "text-sky-600"
                        : "text-red-500"
                  }`}
                >
                  {r.status.replace("_", " ")}
                </span>
              </button>
            ))}
          </div>
        </details>
      )}

      {CATEGORIES.map(([label, ids]) => {
        const items = (catalog ?? []).filter((w) =>
          label === "Custom" ? w.custom : !w.custom && ids.includes(w.id),
        );
        const uncategorized =
          label === "Custom"
            ? []
            : (catalog ?? []).filter(
                (w) => !w.custom && !CATEGORIES.some(([, x]) => x.includes(w.id)),
              );
        const list = label === CATEGORIES[0][0] ? [...items, ...uncategorized] : items;
        if (list.length === 0 && label !== "Custom") return null;
        return (
          <div key={label} className="mt-5">
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              <span
                className={`inline-flex h-1.5 w-1.5 rounded-full ${
                  label === "Development"
                    ? "bg-indigo-500"
                    : label === "Testing"
                      ? "bg-emerald-500"
                      : label === "Custom"
                        ? "bg-violet-500"
                        : "bg-amber-500"
                }`}
              />
              {label}
            </h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((w) => (
                <div
                  key={w.id}
                  className={`group relative rounded-xl border bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md ${
                    selected?.id === w.id
                      ? "border-slate-900 ring-2 ring-slate-900/10"
                      : "border-slate-200"
                  }`}
                >
                  <button onClick={() => pick(w)} className="w-full p-4 text-left">
                    <div className="flex items-start gap-2.5">
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${wfIdentity(w).tint}`}
                      >
                        {(() => {
                          const I = wfIdentity(w).icon;
                          return <I size={16} strokeWidth={1.75} />;
                        })()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                          {w.title}
                          {w.custom && (
                            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-violet-600">
                              {w.scope === "project" ? "custom · this project" : "custom · all projects"}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">{w.description}</p>
                      </div>
                    </div>
                    {Array.isArray(w.steps) && w.steps.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
                        <span className="rounded-md bg-slate-100 px-1.5 py-px text-[11px] font-semibold text-slate-500">
                          {w.steps.length} steps
                        </span>
                        {(() => {
                          const gates = w.steps!.filter((st) => (st as { type?: string }).type === "gate").length;
                          const agents = w.steps!.filter((st) => (st as { type?: string }).type === "agent").length;
                          return (
                            <>
                              {agents > 0 && (
                                <span className="rounded-md bg-indigo-50 px-1.5 py-px text-[11px] font-semibold text-indigo-600">
                                  {agents} agent
                                </span>
                              )}
                              {gates > 0 && (
                                <span className="rounded-md bg-amber-50 px-1.5 py-px text-[11px] font-semibold text-amber-700">
                                  {<Icon.humanGate size={12} strokeWidth={1.75} className="inline shrink-0 text-amber-500" />} {gates} human gate{gates === 1 ? "" : "s"}
                                </span>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </button>
                  <span className="absolute right-2 top-2 flex gap-0.5">
                    <button
                      onClick={() => {
                        setSeed(w);
                        setDesigning(true);
                      }}
                      className="rounded-md px-1.5 text-xs text-slate-300 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100"
                      title="Duplicate to customize - copy this workflow and add/remove steps on top"
                    >
                      ⧉
                    </button>
                    {w.custom && (
                      <button
                        onClick={async () => {
                          await api({ action: "delete-custom", root, workflow: w.id });
                          if (selected?.id === w.id) setSelected(null);
                          refreshCatalog();
                        }}
                        className="rounded-md px-1.5 text-xs text-slate-300 hover:bg-red-50 hover:text-red-500"
                        title="Delete this custom workflow"
                      >
                <Icon.close size={12} strokeWidth={2.25} />
              </button>
                    )}
                  </span>
                </div>
              ))}
              {label === "Custom" && (
                <button
                  onClick={() => {
                    setSeed(null);
                    setDesigning(true);
                  }}
                  className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-left text-slate-400 transition-all hover:-translate-y-0.5 hover:border-slate-500 hover:text-slate-600 hover:shadow-md"
                >
                  <div className="text-sm font-semibold">+ Design a workflow</div>
                  <p className="mt-1 text-xs">
                    Build your own step sequence - same engine, gates, and audit.
                  </p>
                </button>
              )}
            </div>
          </div>
        );
      })}
      {catalog === null && <p className="mt-4 text-xs text-slate-400">loading…</p>}

      {designing && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6"
          onClick={(e) => e.target === e.currentTarget && setDesigning(false)}
        >
          <div className="w-full max-w-3xl">
            <WorkflowBuilder
              root={root}
              seed={seed as unknown as BuilderSeed | null}
              onCancel={() => setDesigning(false)}
              onSaved={() => {
                setDesigning(false);
                refreshCatalog();
              }}
            />
          </div>
        </div>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6"
          onClick={(e) => e.target === e.currentTarget && !starting && setSelected(null)}
        >
          <div className="mt-10 w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">{selected.title}</h3>
                <p className="mt-0.5 text-xs text-slate-500">{selected.description}</p>
              </div>
              <button
                onClick={() => !starting && setSelected(null)}
                className="rounded-md px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                title="Close"
              >
                <Icon.close size={12} strokeWidth={2.25} />
              </button>
            </div>
            <div className="mt-4 space-y-3">
            {selected.inputs.filter((i) => !i.hidden).map((i) =>
              i.kind === "boolean" ? (
                <label key={i.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={inputs[i.key] === true}
                    onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.checked }))}
                  />
                  {i.label}
                </label>
              ) : i.kind === "select" ? (
                <div key={i.key}>
                  <label className="text-xs font-medium text-slate-500">{i.label}</label>
                  <select
                    value={String(inputs[i.key] ?? "")}
                    onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.value }))}
                    className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                  >
                    {(i.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div key={i.key}>
                  <label className="text-xs font-medium text-slate-500">{i.label}</label>
                  <div className="relative mt-1">
                    <textarea
                      value={String(inputs[i.key] ?? "")}
                      onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.value }))}
                      rows={3}
                      className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 ${
                        isAttachTarget(i) ? "pr-10" : ""
                      }`}
                    />
                    {isAttachTarget(i) && (
                      <button
                        onClick={() => fileRef.current?.click()}
                        disabled={uploading || starting}
                        className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-40"
                        title="Attach requirement documents, screenshots, or logs - the AI reads them in full"
                      >
                        {uploading ? (
                          <span className="text-xs">…</span>
                        ) : (
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <path d="M8 3v10M3 8h10" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                  {isAttachTarget(i) && attachments.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {attachments.map((a) => (
                        <span
                          key={a.rel}
                          className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600"
                        >
                          {a.name}
                          <button
                            onClick={() => setAttachments((x) => x.filter((y) => y.rel !== a.rel))}
                            className="text-slate-400 hover:text-slate-700"
                          >
                <Icon.close size={12} strokeWidth={2.25} />
              </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ),
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.doc,.txt,.log,.csv,.md"
              className="hidden"
              onChange={(e) => uploadFiles(e.target.files)}
            />
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-500">Agent:</label>
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value as AgentId)}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
              >
                {AGENT_OPTIONS.map((a) => (
                  <option key={a.id} value={a.id} disabled={status?.[a.id]?.installed === false}>
                    {a.label}
                    {defaultAgent === a.id ? " (default)" : ""}
                    {status?.[a.id]?.installed === false ? " - not installed" : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={() => !starting && setSelected(null)}
                className="ml-auto rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={start}
                disabled={starting}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {starting ? "Starting…" : "Start run"}
              </button>
            </div>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
