import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { IGNORED_DIRS, isAttachableRoot, resolveInside } from "@/lib/fsguard";

/** List one directory of the attached project (lazy tree loading).
 * POST {root, dir?} → {entries: [{name, type}]} sorted dirs-first. */
export async function POST(req: Request) {
  let body: { root?: unknown; dir?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  const rel = typeof body.dir === "string" ? body.dir : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  const abs = resolveInside(root, rel);
  if (!abs) {
    return NextResponse.json({ error: "path escapes the project" }, { status: 400 });
  }

  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return NextResponse.json({ error: "directory not found" }, { status: 404 });
  }

  const entries = dirents
    .filter((d) => (d.isDirectory() ? !IGNORED_DIRS.has(d.name) : d.isFile()))
    .map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }))
    .sort((a, b) =>
      a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    )
    .slice(0, 500);

  return NextResponse.json({ entries });
}
