"use client";

import type { AgentId } from "@/lib/agents";

/** The user's DEFAULT agent - preselected in chat and new workflow runs,
 * highlighted in the Models-by-role panel. One choice, applies everywhere. */

const KEY = "sfdh.defaultAgent";
const VALID = new Set(["copilot", "claude", "codex", "cursor"]);

export function loadDefaultAgent(): AgentId | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && VALID.has(v) ? (v as AgentId) : null;
  } catch {
    return null;
  }
}

export function saveDefaultAgent(id: AgentId | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* best-effort */
  }
}
