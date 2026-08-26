"use client";

import type { StepRole } from "@/lib/workflows/schema";

/** Client-side store for user-configured PER-ROLE models (per agent) — the
 * primary model setting. Empty role = automatic (the role's tier resolves it).
 * Sent with each run so the server resolves steps against the user's choice. */

export type RoleConfig = Partial<Record<StepRole, string>>;

const KEY = "sfdh.roleModels";

export function loadRoles(): Record<string, RoleConfig> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveRoles(all: Record<string, RoleConfig>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* best-effort */
  }
}

export function rolesFor(agent: string): RoleConfig {
  return loadRoles()[agent] ?? {};
}
