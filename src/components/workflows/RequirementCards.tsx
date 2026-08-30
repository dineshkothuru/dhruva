"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";

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

/** Render a REQ block's body as labeled fields (BRD-REF, EVIDENCE, DESIGN…)
 * instead of a text wall - backticked API names become code chips. Shared by
 * the gate cards and the step-trace REQ cards. */
const FIELD_RE = /^(BRD-REF|STATUS|EVIDENCE|ALREADY-PRESENT|PENDING|DESIGN|EFFORT|DEPENDS-ON):\s*(.*)$/;

/** Inline markdown the agents actually emit: `code` and **bold**. Rendering
 * them was the difference between a paragraph and a wall of literal
 * asterisks - agents write markdown whether or not we asked them to. */
export function inlineCode(v: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  v.split("`").forEach((chunk, i) => {
    if (i % 2) {
      out.push(
        <code key={`c${i}`} className="rounded-md bg-slate-100 px-1 py-px font-mono text-[11px] text-slate-700">
          {chunk}
        </code>,
      );
      return;
    }
    // outside code spans, honour **bold**
    chunk.split(/\*\*/).forEach((part, j) => {
      if (!part) return;
      out.push(
        j % 2 ? (
          <strong key={`b${i}-${j}`} className="font-semibold text-slate-900">
            {part}
          </strong>
        ) : (
          <span key={`t${i}-${j}`}>{part}</span>
        ),
      );
    });
  });
  return out;
}

export function ReqBody({ body }: { body: string }) {
  const fields: { label: string; value: string }[] = [];
  let cur: { label: string; value: string } | null = null;
  for (const line of body.split("\n")) {
    const m = line.match(FIELD_RE);
    if (m) {
      cur = { label: m[1], value: m[2] };
      fields.push(cur);
    } else if (cur && line.trim()) {
      cur.value += (cur.value ? " " : "") + line.trim();
    }
  }
  if (fields.length === 0) {
    return (
      <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-600">{body}</pre>
    );
  }
  return (
    <dl className="space-y-1.5">
      {fields
        .filter((f) => f.label !== "STATUS") // status is the header chip
        .map((f) => {
          const none = f.value.trim() === "-" || f.value.trim() === "";
          return (
            <div key={f.label} className="flex gap-2.5">
              <dt className="w-28 shrink-0 pt-0.5 text-right text-[11px] font-bold uppercase tracking-wider text-slate-400">
                {f.label.replace(/-/g, " ")}
              </dt>
              <dd
                className={`min-w-0 flex-1 text-[11px] leading-relaxed ${
                  none
                    ? "text-slate-300"
                    : f.label === "DESIGN"
                      ? "rounded-md bg-sky-50/70 px-2 py-1 text-slate-800"
                      : f.label === "PENDING"
                        ? "font-medium text-amber-700"
                        : "text-slate-700"
                }`}
              >
                {none ? "none" : inlineCode(f.value)}
              </dd>
            </div>
          );
        })}
    </dl>
  );
}

const STATUS_STYLE: Record<string, string> = {
  "ALREADY IMPLEMENTED": "bg-emerald-50 text-emerald-700",
  PARTIAL: "bg-amber-50 text-amber-700",
  NEW: "bg-sky-50 text-sky-700",
};

export default function RequirementCards({
  items,
  onSubmit,
  onChange,
  onApproveAll,
  disabled,
  critique,
}: {
  items: ReqItem[];
  /** The human's rulings, per requirement, as DATA.
   *
   * This used to compile every verdict into one prose instruction and send it
   * as a plain revise. The words reached the designer, but nothing else did:
   * no block was frozen, an "approved" card could be rewritten in the next
   * round, and nothing recorded WHICH requirements a human had actually
   * signed. The states existed in the document all along - the gate simply
   * had no way to say them. */
  onSubmit: (cards: { id: string; verdict: "approve" | "revise"; note?: string }[]) => void;
  /** Every change, reported up as it happens.
   *
   * The gate has its own Approve / Revise buttons BELOW these cards. Without
   * this the marks lived only in here, so a person who approved four cards,
   * rejected two with their own design in the notes, and then clicked the
   * gate's "Revise with instructions" button lost all of it silently. Whichever
   * button they reach for, the rulings go with it. */
  onChange?: (cards: { id: string; verdict: "approve" | "revise"; note?: string }[]) => void;
  onApproveAll: () => void;
  disabled?: boolean;
  /** Reviewer objections per REQ id - WHY the critic blocked, shown on the card. */
  critique?: Record<string, string[]>;
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
  const approvedCount = useMemo(
    () => items.filter((i) => decisions[i.id] === "approve").length,
    [items, decisions],
  );

  // Only ruled cards count. An untouched card is NOT a silent approval:
  // saying nothing about a requirement must never sign it off, so it keeps
  // whatever state the review left it in.
  const cards = useMemo(
    () =>
      items
        .filter((i) => decisions[i.id] || comments[i.id]?.trim())
        .map((i) => ({
          id: i.id,
          verdict: (decisions[i.id] === "reject" ? "revise" : "approve") as "approve" | "revise",
          note: comments[i.id]?.trim() || undefined,
        })),
    [items, decisions, comments],
  );
  useEffect(() => onChange?.(cards), [cards, onChange]);

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
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${
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
                  <Icon.check size={11} strokeWidth={2.25} className="inline" /> Approve
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
                  <Icon.close size={11} strokeWidth={2.25} className="inline" /> Reject
                </button>
              </span>
            </div>
            {(critique?.[i.id]?.length ?? 0) > 0 && (
              <div className="mt-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-red-600">
                  reviewer objects
                </p>
                {critique![i.id].map((c, n) => (
                  <p key={n} className="mt-0.5 whitespace-pre-wrap text-[11px] text-red-800">
                    {c}
                  </p>
                ))}
              </div>
            )}
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600">
                design details
              </summary>
              <div className="mt-1 rounded-md bg-slate-50 p-2.5">
                <ReqBody body={i.body} />
              </div>
            </details>
            <textarea
              value={comments[i.id] ?? ""}
              onChange={(e) => setComments((v) => ({ ...v, [i.id]: e.target.value }))}
              rows={d === "reject" ? 4 : 2}
              placeholder={
                d === "reject"
                  ? "What is wrong, and the design you want instead - paste as much as you like. This is mandatory input to the rework."
                  : "Optional note for this item - kept on the requirement as your own design input."
              }
              className="mt-1.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
            />
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-1">
        <span className="text-[11px] text-slate-400">
          {items.length} requirements · {approvedCount} approved · {rejected.length} sent back ·{" "}
          {commented.length} with notes
        </span>
        {rejected.length > 0 || commented.length > 0 || approvedCount > 0 ? (
          <button
            onClick={() => onSubmit(cards)}
            disabled={disabled}
            className="ml-auto rounded-lg border border-amber-400 bg-amber-50 px-4 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-40"
          >
            {rejected.length > 0
              ? `Send back ${rejected.length}, approve ${approvedCount}`
              : `Approve ${approvedCount} with notes`}
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
