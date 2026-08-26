"use client";

import { useMemo, useState } from "react";

/** Itemized design review: parses "### REQ-xxx" blocks from the analyse
 * step's output into cards with per-item Approve / Reject + comment. The
 * decisions compile into ONE deterministic revise instruction (rejected
 * items reworked, approved items frozen) that rides the existing gate. */

export interface ReqItem {
  id: string;
  title: string;
  status: string;
  body: string; // the block's remaining lines, pre-formatted
}

export function parseRequirements(output: string): ReqItem[] {
  const items: ReqItem[] = [];
  const re = /^###\s+(REQ-\d+):\s*(.+)$/gm;
  const marks: { id: string; title: string; start: number }[] = [];
  for (const m of output.matchAll(re)) {
    marks.push({ id: m[1], title: m[2].trim(), start: m.index ?? 0 });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : output.length;
    const block = output.slice(marks[i].start, end);
    const status = block.match(/^STATUS:\s*(.+)$/m)?.[1]?.trim() ?? "?";
    const body = block.split("\n").slice(1).join("\n").trim();
    items.push({ id: marks[i].id, title: marks[i].title, status, body });
  }
  return items;
}

const STATUS_STYLE: Record<string, string> = {
  "ALREADY IMPLEMENTED": "bg-emerald-50 text-emerald-700",
  PARTIAL: "bg-amber-50 text-amber-700",
  NEW: "bg-sky-50 text-sky-700",
};

export default function RequirementCards({
  items,
  onSubmit,
  onApproveAll,
  disabled,
}: {
  items: ReqItem[];
  /** Called with the compiled revise instruction when any item is rejected. */
  onSubmit: (reviseInstruction: string) => void;
  onApproveAll: () => void;
  disabled?: boolean;
}) {
  const [decisions, setDecisions] = useState<Record<string, "approve" | "reject">>({});
  const [comments, setComments] = useState<Record<string, string>>({});

  const rejected = useMemo(
    () => items.filter((i) => decisions[i.id] === "reject"),
    [items, decisions],
  );
  const commented = useMemo(
    () => items.filter((i) => decisions[i.id] !== "reject" && comments[i.id]?.trim()),
    [items, decisions, comments],
  );

  function submit() {
    const lines: string[] = [];
    for (const i of rejected) {
      lines.push(`${i.id} REJECTED${comments[i.id]?.trim() ? `: ${comments[i.id].trim()}` : ""} — rework this item.`);
    }
    for (const i of commented) {
      lines.push(`${i.id} note (item stays approved, incorporate this): ${comments[i.id].trim()}`);
    }
    lines.push(
      "Rework the rejected items above, AND any other REQ whose DEPENDS-ON chain includes a " +
        "reworked item — adjust those only as far as the changed dependency forces, noting what " +
        "rippled. Keep every unaffected REQ block EXACTLY as it was (same ids, same order, full " +
        "output again).",
    );
    onSubmit(lines.join("\n"));
  }

  return (
    <div className="mt-2 space-y-2">
      {items.map((i) => {
        const d = decisions[i.id];
        return (
          <div
            key={i.id}
            className={`rounded-xl border bg-white p-3 ${
              d === "reject" ? "border-red-300 ring-1 ring-red-100" : d === "approve" ? "border-emerald-300" : "border-slate-200"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-slate-400">{i.id}</span>
              <span className="text-sm font-semibold">{i.title}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  STATUS_STYLE[i.status.toUpperCase()] ?? "bg-slate-100 text-slate-500"
                }`}
              >
                {i.status}
              </span>
              <span className="ml-auto flex gap-1">
                <button
                  onClick={() => setDecisions((v) => ({ ...v, [i.id]: "approve" }))}
                  disabled={disabled}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                    d === "approve"
                      ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                      : "border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  ✓ Approve
                </button>
                <button
                  onClick={() => setDecisions((v) => ({ ...v, [i.id]: "reject" }))}
                  disabled={disabled}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                    d === "reject"
                      ? "border-red-400 bg-red-50 text-red-700"
                      : "border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  ✗ Reject
                </button>
              </span>
            </div>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600">
                design details
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-700">
                {i.body}
              </pre>
            </details>
            <input
              value={comments[i.id] ?? ""}
              onChange={(e) => setComments((v) => ({ ...v, [i.id]: e.target.value }))}
              placeholder={d === "reject" ? "Why rejected / what to do instead…" : "Optional comment for this item…"}
              className="mt-1.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
            />
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-1">
        <span className="text-[11px] text-slate-400">
          {items.length} requirements · {rejected.length} rejected · {commented.length} with notes
        </span>
        {rejected.length > 0 || commented.length > 0 ? (
          <button
            onClick={submit}
            disabled={disabled}
            className="ml-auto rounded-lg border border-amber-400 bg-amber-50 px-4 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-40"
          >
            Submit review — rework {rejected.length} item(s)
          </button>
        ) : (
          <button
            onClick={onApproveAll}
            disabled={disabled}
            className="ml-auto rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Approve all & continue
          </button>
        )}
      </div>
    </div>
  );
}
