import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import mammoth from "mammoth";
import { isAttachableRoot } from "@/lib/fsguard";

/** Save a chat attachment (issue screenshot / PDF / doc) into the attached
 * project's harness area so agents can read it from disk.
 * POST multipart/form-data {root, file} → {rel} (project-relative path).
 *
 * Word documents are binary zips the agents' file-read tools cannot parse —
 * a read-only agent then wastes calls on doomed workarounds (shell denied,
 * write denied). So .docx text is extracted DETERMINISTICALLY here at upload
 * and the agents get the extracted .md as the file to read. */

const ALLOWED_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".pdf", ".docx", ".doc", ".txt", ".log", ".csv", ".md",
]);
const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "multipart form-data expected" }, { status: 400 });
  }

  const rootRaw = form.get("root");
  const file = form.get("file");
  const root = typeof rootRaw === "string" ? path.normalize(rootRaw.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large (max 15 MB)" }, { status: 413 });
  }

  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json(
      { error: `file type not allowed (${ext || "none"}) — images, pdf, doc, txt` },
      { status: 400 },
    );
  }

  const safeBase = path
    .basename(file.name, ext)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 60);
  const name = `${Date.now().toString(36)}-${safeBase}${ext}`;
  const dir = path.join(root, ".sfharness", "attachments");
  await fs.mkdir(dir, { recursive: true });
  const abs = path.join(dir, name);
  await fs.writeFile(abs, Buffer.from(await file.arrayBuffer()));

  if (ext === ".docx") {
    try {
      const { value } = await mammoth.extractRawText({ path: abs });
      const text = (value ?? "").trim();
      if (text.length > 0) {
        const extractedName = `${name}.extracted.md`;
        await fs.writeFile(
          path.join(dir, extractedName),
          `<!-- Extracted from ${file.name} at upload; the original .docx sits alongside. -->\n\n${text}\n`,
          "utf8",
        );
        // agents read the extracted text, not the binary
        return NextResponse.json({
          rel: `.sfharness/attachments/${extractedName}`,
          name: file.name,
          extracted: true,
        });
      }
    } catch {
      /* extraction failed — fall through to the original file reference */
    }
  }

  return NextResponse.json({ rel: `.sfharness/attachments/${name}`, name: file.name });
}
