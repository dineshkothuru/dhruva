import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";

/** Local folder browser for the attach picker (the server runs on the same
 * machine as the user, so listing directories is the user browsing their own
 * disk). Directories only; hidden/system folders filtered.
 * POST {dir?} → {dir, parent, entries:[names]} — no dir = list drives. */
export async function POST(req: Request) {
  let body: { dir?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // NOTE: path.normalize("") returns "." — empty must stay empty (drive list)
  const rawDir = typeof body.dir === "string" ? body.dir.trim() : "";
  const dir = rawDir ? path.normalize(rawDir) : "";

  if (!dir) {
    // drive roots (Windows) or filesystem root (posix)
    if (process.platform === "win32") {
      const drives: string[] = [];
      for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZAB") {
        try {
          await fs.stat(`${letter}:\\`);
          drives.push(`${letter}:\\`);
        } catch {
          /* no such drive */
        }
      }
      return NextResponse.json({ dir: "", parent: null, entries: drives });
    }
    return NextResponse.json({ dir: "/", parent: null, entries: ["/"] });
  }

  if (!path.isAbsolute(dir)) {
    return NextResponse.json({ error: "absolute path required" }, { status: 400 });
  }
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("$") && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 400);
    const parentPath = path.dirname(dir);
    const parent = parentPath === dir ? "" : parentPath; // drive root → back to drive list
    // is this folder already an SFDX project? (picker highlights it)
    const isProject = await fs
      .stat(path.join(dir, "sfdx-project.json"))
      .then((s) => s.isFile())
      .catch(() => false);
    return NextResponse.json({ dir, parent, entries, isProject });
  } catch {
    return NextResponse.json({ error: "cannot read that folder" }, { status: 400 });
  }
}
