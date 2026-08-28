"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

/** Per-project settings (.dhruva/settings.json) - lives in the LEFT
 * project panel with the rest of the per-project configuration (skills,
 * standards browser). Today: the UX design configuration consumed by the
 * Solution design workflow's conditional UX steps. */

interface UxSettings {
  enabled: boolean;
  designDir: string;
  rules: string;
}

export default function ProjectSettingsPanel({ root }: { root: string }) {
  const [ux, setUx] = useState<UxSettings>({ enabled: false, designDir: ".dhruva/uxdesignfiles", rules: "" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/project-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root }),
        }).then((x) => x.json());
        if (!cancelled && r.settings?.ux) setUx(r.settings.ux as UxSettings);
      } catch {
        /* defaults stand */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root]);

  async function save(next: UxSettings) {
    setUx(next);
    setSaved(false);
    const res = await fetch("/api/project-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, settings: { ux: next } }),
    });
    if (res.ok) setSaved(true);
  }

  return (
    <div className="border-t border-slate-100 px-5 py-3">
      <details>
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-widest text-slate-400 hover:text-slate-600">
          <Icon.setup size={12} strokeWidth={1.75} className="mr-1 inline" /> Project settings - UX design {ux.enabled ? "(on)" : "(off)"}
        </summary>
        <div className="mt-2 space-y-2.5">
          <p className="text-[11px] leading-relaxed text-slate-400">
            Per-project (.dhruva/settings.json). When ON, Solution design adds UX steps for the
            UI-scoped requirements - designed under the rules below, critiqued, gated, and carried
            into the TDD + build-plan tasks. When OFF, Solution design is unchanged.
          </p>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={ux.enabled}
              onChange={(e) => void save({ ...ux, enabled: e.target.checked })}
            />
            Include UX design in Solution design runs
          </label>
          <label className="block text-[11px] font-medium text-slate-500">
            Standing design folder (style guides, conventions)
            <input
              value={ux.designDir}
              onChange={(e) => setUx({ ...ux, designDir: e.target.value })}
              onBlur={() => void save({ ...ux, designDir: ux.designDir.trim() || ".dhruva/uxdesignfiles" })}
              spellCheck={false}
              className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-slate-400"
            />
          </label>
          <label className="block text-[11px] font-medium text-slate-500">
            Project UX rules (injected into every UX design prompt)
            <textarea
              value={ux.rules}
              onChange={(e) => setUx({ ...ux, rules: e.target.value })}
              onBlur={() => void save(ux)}
              rows={3}
              placeholder="e.g. SLDS only, no custom CSS. Tables use lightning-datatable. Forms are two-column."
              className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
            />
          </label>
          {saved && <p className="text-[11px] text-emerald-600">saved</p>}
        </div>
      </details>
    </div>
  );
}
