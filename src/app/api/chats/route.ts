import { NextResponse } from "next/server";
import { isAttachableRoot } from "@/lib/fsguard";
import { listChats, readChat, saveChat } from "@/lib/chatFiles";
import type { StoredMsg } from "@/lib/chatStore";

/** Chat threads stored with the project, under .dhruva/chats.
 * POST {action:"list", root}            → thread headers, newest first
 * POST {action:"get", root, id}         → one thread with its messages
 * POST {action:"save", root, id, messages} → write/update one thread */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof b.root === "string" ? b.root.trim() : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }

  if (b.action === "list") {
    return NextResponse.json({ threads: await listChats(root) });
  }

  if (b.action === "get") {
    if (typeof b.id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    const thread = await readChat(root, b.id);
    if (!thread) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(thread);
  }

  if (b.action === "save") {
    if (typeof b.id !== "string" || !Array.isArray(b.messages)) {
      return NextResponse.json({ error: "id and messages required" }, { status: 400 });
    }
    // cap what one thread can occupy on disk
    const messages = (b.messages as StoredMsg[]).slice(-200);
    return NextResponse.json({ saved: await saveChat(root, b.id, messages) });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
