import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { isAttachableRoot } from "@/lib/fsguard";
import {
  deleteSkill,
  findSecret,
  isSkillName,
  listSkills,
  readSkill,
  saveSkill,
  skillsPrompt,
} from "@/lib/projectSkills";
import { extractDocText } from "@/lib/docExtract";

/** Project skills - per-project knowledge under .sfharness/skills/.
 * JSON: POST {action: list|get|save|delete, root, name?, content?}
 * Upload: multipart {root, name, file} - .md/.txt kept, .docx/.pdf extracted. */
export async function POST(req: Request) {
  // ---- multipart: file upload becomes a skill
  if (req.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await req.formData();
    const root = typeof form.get("root") === "string" ? path.normalize(String(form.get("root")).trim()) : "";
    const name = String(form.get("name") ?? "").trim().toLowerCase();
    const file = form.get("file");
    if (!root || !(await isAttachableRoot(root))) {
      return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
    }
    if (!isSkillName(name)) {
      return NextResponse.json({ error: "name must be a lowercase slug" }, { status: 400 });
    }
    if (!(file instanceof File) || file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "file required (max 20 MB)" }, { status: 400 });
    }
    const ext = path.extname(file.name).toLowerCase();
    let content: string | null = null;
    if (ext === ".md" || ext === ".txt") {
      content = Buffer.from(await file.arrayBuffer()).toString("utf8");
    } else if (ext === ".docx" || ext === ".pdf") {
      // deterministic extraction, same pipeline as attachments
      const tmp = path.join(os.tmpdir(), `dhruva-skill-${Date.now().toString(36)}${ext}`);
      await fs.writeFile(tmp, Buffer.from(await file.arrayBuffer()));
      content = await extractDocText(tmp);
      await fs.unlink(tmp).catch(() => {});
      if (!content) {
        return NextResponse.json(
          { error: "no text could be extracted (scanned/image document?) - paste the text instead" },
          { status: 400 },
        );
      }
    } else {
      return NextResponse.json({ error: `unsupported type ${ext} - md, txt, docx, pdf` }, { status: 400 });
    }
    try {
      await saveSkill(root, name, content);
    } catch (e) {
      return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
    }
    return NextResponse.json({ saved: name });
  }

  // ---- JSON actions
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const root = typeof b.root === "string" ? path.normalize(b.root.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }

  if (b.action === "list") {
    const skills = await listSkills(root);
    const { chars } = await skillsPrompt(root);
    return NextResponse.json({ skills, injectedChars: chars });
  }
  if (b.action === "get") {
    if (!isSkillName(b.name)) return NextResponse.json({ error: "bad name" }, { status: 400 });
    const content = await readSkill(root, b.name);
    if (content === null) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ name: b.name, content });
  }
  if (b.action === "save") {
    if (!isSkillName(b.name) || typeof b.content !== "string") {
      return NextResponse.json({ error: "name (lowercase slug) + content required" }, { status: 400 });
    }
    // pre-check for a clearer error shape (saveSkill re-checks)
    const secret = findSecret(b.content);
    if (secret) {
      return NextResponse.json(
        { error: `looks like a credential ("${secret}") - skills must never carry secrets` },
        { status: 400 },
      );
    }
    try {
      await saveSkill(root, b.name, b.content);
    } catch (e) {
      return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
    }
    return NextResponse.json({ saved: b.name });
  }
  if (b.action === "delete") {
    if (!isSkillName(b.name)) return NextResponse.json({ error: "bad name" }, { status: 400 });
    return NextResponse.json({ deleted: await deleteSkill(root, b.name) });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
