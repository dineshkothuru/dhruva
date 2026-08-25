import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { IGNORED_DIRS, isAttachableRoot } from "@/lib/fsguard";

const MAX_RESULTS = 50;
const MAX_VISITED = 30_000;

/** Filename search across the attached project.
 * POST {root, q} → {results: ["rel/path", …]} (substring, case-insensitive). */
export async function POST(req: Request) {
  let body: { root?: unknown; q?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  const q = typeof body.q === "string" ? body.q.trim().toLowerCase() : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const absRoot = path.resolve(root);
  const results: string[] = [];
  let visited = 0;

  async function walk(dirAbs: string, rel: string): Promise<void> {
    if (results.length >= MAX_RESULTS || visited >= MAX_VISITED) return;
    let dirents;
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (results.length >= MAX_RESULTS || ++visited >= MAX_VISITED) return;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!IGNORED_DIRS.has(d.name)) await walk(path.join(dirAbs, d.name), childRel);
      } else if (d.isFile() && d.name.toLowerCase().includes(q)) {
        results.push(childRel);
      }
    }
  }

  await walk(absRoot, "");
  return NextResponse.json({ results, truncated: results.length >= MAX_RESULTS });
}
