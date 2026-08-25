import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { MAX_FILE_BYTES, isAttachableRoot, resolveInside } from "@/lib/fsguard";

/** Read or write ONE file inside the attached project.
 * POST {root, file, action: "read"} → {content}
 * POST {root, file, action: "write", content} → {saved: true} */
export async function POST(req: Request) {
  let body: { root?: unknown; file?: unknown; action?: unknown; content?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  const rel = typeof body.file === "string" ? body.file : "";
  if (!root || !rel || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  const abs = resolveInside(root, rel);
  if (!abs) {
    return NextResponse.json({ error: "path escapes the project" }, { status: 400 });
  }

  if (body.action === "read") {
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return NextResponse.json({ error: "file not found" }, { status: 404 });
    }
    if (!stat.isFile()) {
      return NextResponse.json({ error: "not a file" }, { status: 400 });
    }
    if (stat.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "file too large for the editor" }, { status: 413 });
    }
    const content = await fs.readFile(abs, "utf8");
    return NextResponse.json({ content });
  }

  if (body.action === "write") {
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content (string) required" }, { status: 400 });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "content too large" }, { status: 413 });
    }
    // Only overwrite existing files — creating files stays with the agent/CLI.
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) {
      return NextResponse.json({ error: "file not found" }, { status: 404 });
    }
    await fs.writeFile(abs, body.content, "utf8");
    return NextResponse.json({ saved: true });
  }

  return NextResponse.json({ error: "action must be read or write" }, { status: 400 });
}
