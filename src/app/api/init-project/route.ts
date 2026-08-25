import { NextResponse } from "next/server";
import path from "node:path";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { detectProject } from "@/lib/detect";

/** Create the folder if needed and scaffold a Salesforce DX project into it
 * via `sf project generate` (same structure VS Code creates). Only proceeds
 * when the target is missing or an empty directory — never scaffolds into a
 * folder that already has files. Returns the fresh detection result. */
export async function POST(req: Request) {
  let body: { path?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const p = body.path;
  if (typeof p !== "string" || p.trim().length === 0 || p.length > 500) {
    return NextResponse.json({ error: "path (string) is required" }, { status: 400 });
  }
  const target = path.normalize(p.trim());
  if (!path.isAbsolute(target)) {
    return NextResponse.json({ error: "absolute path required" }, { status: 400 });
  }

  const name = path.basename(target);
  const parent = path.dirname(target);
  if (!name || parent === target) {
    return NextResponse.json({ error: "cannot scaffold at a drive root" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
    return NextResponse.json(
      { error: "folder name must start with a letter/digit and use only letters, digits, space, . _ -" },
      { status: 400 },
    );
  }

  const stat = await fs.stat(target).catch(() => null);
  if (stat && !stat.isDirectory()) {
    return NextResponse.json({ error: "path exists and is a file" }, { status: 400 });
  }
  if (stat) {
    const entries = await fs.readdir(target);
    if (entries.length > 0) {
      return NextResponse.json(
        { error: "folder is not empty — refusing to scaffold over existing files" },
        { status: 409 },
      );
    }
  }

  await fs.mkdir(parent, { recursive: true });

  const err = await new Promise<string | null>((resolve) => {
    execFile(
      "sf",
      ["project", "generate", "--name", `"${name}"`, "--output-dir", `"${parent}"`, "--template", "standard"],
      {
        cwd: parent,
        timeout: 120_000,
        shell: true,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (e, _stdout, stderr) => resolve(e ? stderr || e.message : null),
    );
  });
  if (err) {
    return NextResponse.json({ error: `sf project generate failed: ${err.slice(0, 400)}` }, { status: 500 });
  }

  const result = await detectProject(target);
  return NextResponse.json(result);
}
