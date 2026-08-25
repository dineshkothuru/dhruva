import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { isAttachableRoot, resolveInside, MAX_FILE_BYTES } from "@/lib/fsguard";
import { baselineContent, changesSince } from "@/lib/snapshot";

/** Deterministic review of what changed since the last snapshot (taken
 * automatically before each agent run). Git-server-independent — works for
 * projects with no git at all (the org-sourced folders).
 * POST {root} → {changes: [{file, status}]}
 * POST {root, file} → {before, after} for the diff view. */
export async function POST(req: Request) {
  let body: { root?: unknown; file?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }

  if (typeof body.file === "string") {
    const abs = resolveInside(root, body.file);
    if (!abs) {
      return NextResponse.json({ error: "path escapes the project" }, { status: 400 });
    }
    const before = await baselineContent(root, body.file);
    let after: string | null = null;
    const stat = await fs.stat(abs).catch(() => null);
    if (stat?.isFile() && stat.size <= MAX_FILE_BYTES) {
      after = await fs.readFile(abs, "utf8");
    }
    return NextResponse.json({ before, after });
  }

  const changes = await changesSince(root);
  if (changes === null) {
    return NextResponse.json({ error: "snapshot store unavailable (is git installed?)" }, { status: 500 });
  }
  return NextResponse.json({ changes });
}
