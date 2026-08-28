import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot } from "@/lib/fsguard";
import { discardStaged } from "@/lib/attachments";

/** Drop staged uploads the user decided not to use.
 *
 * Called when an attachment is removed from the form, and when the form is
 * closed or cancelled without starting a run. Without it, every abandoned
 * upload stayed on disk forever: one project reached thirteen copies of the
 * same document, which is not just clutter - an agent that lists the folder
 * rather than using the exact path is choosing between them at random.
 *
 * Only the staging folder is touched. A run's own attachments are part of its
 * audit and are never deletable this way.
 *
 * POST {root, names: string[]} -> {removed: number} */
export async function POST(req: Request) {
  let body: { root?: unknown; names?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  const names = (Array.isArray(body.names) ? body.names : []).filter(
    (n): n is string => typeof n === "string",
  );
  if (names.length === 0) return NextResponse.json({ removed: 0 });

  const removed = await discardStaged(root, names).catch(() => 0);
  return NextResponse.json({ removed });
}
