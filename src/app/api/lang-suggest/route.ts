import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot, resolveInside, MAX_FILE_BYTES } from "@/lib/fsguard";
import { completion } from "@/lib/lsp/client";
import { docText, insertTextFor, isSnippet, lspKindName } from "@/lib/lsp/protocol";

/** Completions for one position in one file, from a Salesforce language server.
 * POST {root, file, text, line, character} → {ready, items, server?, reason?}
 *
 * Local only: the language server indexes the project on disk and never talks
 * to an org. Read-only - nothing here writes a file.
 *
 * The response deliberately reports `ready:false` instead of waiting when the
 * server is still indexing, because this route sits on a keystroke. */
export async function POST(req: Request) {
  let body: {
    root?: unknown;
    file?: unknown;
    text?: unknown;
    line?: unknown;
    character?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  const rel = typeof body.file === "string" ? body.file.replace(/\\/g, "/") : "";
  const text = typeof body.text === "string" ? body.text : "";
  const line = typeof body.line === "number" ? body.line : -1;
  const character = typeof body.character === "number" ? body.character : -1;

  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  if (!rel || !resolveInside(root, rel)) {
    return NextResponse.json({ error: "path escapes the project" }, { status: 400 });
  }
  if (line < 0 || character < 0) {
    return NextResponse.json({ error: "line and character are required" }, { status: 400 });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    return NextResponse.json({ ready: false, items: [], reason: "file too large" });
  }

  const out = await completion(root, rel, text, line, character);

  // Flattened here rather than in the browser so the client stays a thin
  // mapper: it only has to turn a kind NAME into the live Monaco enum value.
  const items = out.items.slice(0, 500).map((it) => ({
    label: it.label,
    kindName: lspKindName(it.kind),
    detail: typeof it.detail === "string" ? it.detail : "",
    doc: docText(it.documentation),
    insertText: insertTextFor(it),
    snippet: isSnippet(it),
    filterText: typeof it.filterText === "string" ? it.filterText : undefined,
    sortText: typeof it.sortText === "string" ? it.sortText : undefined,
  }));

  return NextResponse.json({
    ready: out.ready,
    server: out.server,
    reason: out.reason,
    items,
  });
}
