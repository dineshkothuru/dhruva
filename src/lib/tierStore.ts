"use client";

/** Client-side store for user-configured model tiers (per agent).
 * Overrides the shipped defaults in agents.ts; sent with each run/chat so the
 * server resolves steps against the user's setting. */

export interface TierConfig {
  best?: string;
  default?: string;
  light?: string;
}

const KEY = "sfdh.tiers";

export function loadTiers(): Record<string, TierConfig> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveTiers(all: Record<string, TierConfig>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* best-effort */
  }
}

export function tiersFor(agent: string): TierConfig {
  return loadTiers()[agent] ?? {};
}
