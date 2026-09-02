"use client";

import { useEffect, useState } from "react";
import type { RunState } from "@/lib/workflows/schema";
import { ROLE_ICON, WF_ICON, wfIconFor, type IconType } from "@/components/icons";

/** Pure helpers and self-contained subcomponents shared by the workflows UI -
 * extracted from the WorkflowsPane monolith so identity/row logic can be read
 * (and tested) apart from the pane's thirty state hooks. */

export interface CatalogItem {
  id: string;
  title: string;
  description: string;
  custom?: boolean;
  /** custom workflows: where they live - central (all projects) or project. */
  scope?: "central" | "project";
  /** project scope: false = ships with the repo and is not yet approved to run. */
  trusted?: boolean;
  /** central scope: a same-id project copy exists in the repo and is shadowed. */
  shadowsProject?: boolean;
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

/** One row per EXECUTION, not per step.
 *
 * A step can run several times - an auto-revise replays its target, a gate
 * revision replays it again - and the replay overwrites the step's fields. The
 * finished attempts are kept on `step.attempts`, so the history renders them as
 * their own rows, oldest first, with the current state last. A design reworked
 * three times shows four rows instead of one. */
export type StepRow = RunState["steps"][number] & {
  rowKey: string;
  attemptNo: number;
  attemptsTotal: number;
  supersededBy?: string;
  /** the step's position in the workflow, used only to order rows that have
   * not started and therefore have no timestamp */
  order: number;
};

export function stepRows(run: RunState): StepRow[] {
  const out: StepRow[] = [];
  run.steps.forEach((s, order) => {
    const earlier = s.attempts ?? [];
    const total = earlier.length + 1;
    earlier.forEach((a, n) => {
      out.push({ ...s, ...a, rowKey: `${s.id}#${n}`, attemptNo: n + 1, attemptsTotal: total, order });
    });
    out.push({ ...s, rowKey: s.id, attemptNo: total, attemptsTotal: total, order });
  });
  // CHRONOLOGICAL, not grouped by step. Grouping listed every run of `analyse`
  // and then every run of `design-review`, so a three-round rework read as
  // analyse/analyse/analyse/review/review/review - which is not what happened.
  // The truth interleaves: design, review, redesign, re-review, and so on.
  // Steps that have not started yet keep the workflow's declared order, at the
  // end, because they have no time to sort by.
  return out.sort((a, b) => {
    if (a.startedAt && b.startedAt) return a.startedAt - b.startedAt;
    if (a.startedAt) return -1;
    if (b.startedAt) return 1;
    return a.order - b.order;
  });
}

/** Custom workflows auto-pick a fitting identity from their title/description
 * keywords - deterministic, so the same workflow always gets the same face. */
export function wfIdentity(w: { id: string; title: string; description: string }): {
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
export const ROLE_META: Record<string, { icon: IconType; tint: string; blurb: string; steps: string[] }> = {
  read: { icon: ROLE_ICON.read, tint: "bg-sky-100 text-sky-700", blurb: "investigates code and documents before anything changes", steps: ["locate", "plan", "assess"] },
  design: { icon: ROLE_ICON.design, tint: "bg-indigo-100 text-indigo-700", blurb: "authors designs, specs, and documents", steps: ["analyse", "spec", "write-doc"] },
  implement: { icon: ROLE_ICON.implement, tint: "bg-slate-200 text-slate-700", blurb: "writes the code and tests", steps: ["implement"] },
  review: { icon: ROLE_ICON.review, tint: "bg-amber-100 text-amber-700", blurb: "adversarially critiques designs and diffs", steps: ["design-review", "review"] },
  trace: { icon: ROLE_ICON.trace, tint: "bg-emerald-100 text-emerald-700", blurb: "verifies every requirement is covered", steps: ["coverage-check", "traceability"] },
};

/** A destructive action that asks first, in the page.
 *
 * These buttons used to guard themselves with `window.confirm`. In an embedded
 * webview - the app shell, and the preview pane this is tested in - native
 * dialogs are suppressed: `confirm()` returns false immediately without ever
 * showing anything, so "Stop run" silently did nothing while the run kept
 * going. Two clicks in the page work everywhere, and the armed state says what
 * the second click will do. */
export function ConfirmButton({
  label,
  armed,
  title,
  className,
  onConfirm,
  disabled,
}: {
  label: string;
  /** what the button says once it is waiting for the second click */
  armed: string;
  title: string;
  className: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    // disarm on its own, so a button left armed cannot be triggered later by
    // a click the user has forgotten the meaning of
    const t = setTimeout(() => setPending(false), 6000);
    return () => clearTimeout(t);
  }, [pending]);
  return (
    <button
      onClick={async () => {
        if (!pending) {
          setPending(true);
          return;
        }
        setPending(false);
        await onConfirm();
      }}
      disabled={disabled}
      title={title}
      className={
        pending
          ? "rounded-lg border border-red-400 bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-700"
          : className
      }
    >
      {pending ? armed : label}
    </button>
  );
}
