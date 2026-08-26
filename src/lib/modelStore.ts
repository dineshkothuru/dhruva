"use client";

/** Custom model ids the user has typed (per agent) — fed back as datalist
 * suggestions so a model id typed once autocompletes everywhere afterward.
 * No management UI: the list grows from use. */

const KEY = "sfdh.customModels";
const CAP = 20;

function loadAll(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function loadCustomModels(agent: string): string[] {
  return loadAll()[agent] ?? [];
}

export function addCustomModel(agent: string, id: string) {
  const v = id.trim();
  if (!v || v.length > 60) return;
  const all = loadAll();
  const list = all[agent] ?? [];
  if (list.includes(v)) return;
  all[agent] = [v, ...list].slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* best-effort */
  }
}
