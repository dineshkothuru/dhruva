import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot, resolveInside, MAX_FILE_BYTES } from "@/lib/fsguard";
import { hasActiveRun } from "@/lib/workflows/engine";
import { compareFileWithOrg } from "@/lib/orgCompare";

/** Compare ONE local file against the connected org's copy of it.
 * POST {root, file} → {org, local, type?}
 *
 * Read-only on both sides: the org is only read, and the local file is only
 * read. The retrieve happens in a throwaway sandbox project - see
 * src/lib/orgCompare.ts for why that is not optional.
 *
 * This is the counterpart to /api/retrieve-file, which OVERWRITES the local
 * file. Compare is what you do before deciding whether you want that. */
export async function POST(req: Request) {
  let body: { root?: unknown; file?: unknown; force?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  const rel = typeof body.file === "string" ? body.file.replace(/\\/g, "/") : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  if (!rel || !resolveInside(root, rel)) {
    return NextResponse.json({ error: "path escapes the project" }, { status: 400 });
  }

  // Same reason the Org Browser and per-file retrieve pause during a run: the
  // sandbox lives under .dhruva/tmp inside the project a run is measuring, and
  // a compare fires several sf calls at an org the run may also be using.
  if (hasActiveRun(root)) {
    return NextResponse.json(
      { error: "a workflow run is in progress - compare is paused until it finishes" },
      { status: 409 },
    );
  }

  // force=true is the Re-fetch button: it must never be answered from the
  // cache, or "is this still current?" has no definite answer.
  const result = await compareFileWithOrg(root, rel, { force: body.force === true });
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  if (
    (result.org && Buffer.byteLength(result.org, "utf8") > MAX_FILE_BYTES) ||
    (result.local && Buffer.byteLength(result.local, "utf8") > MAX_FILE_BYTES)
  ) {
    return NextResponse.json({ error: "file too large to compare" }, { status: 413 });
  }
  return NextResponse.json({
    org: result.org,
    local: result.local,
    type: result.type,
    fetchedAt: result.fetchedAt,
    cached: result.cached === true,
  });
}
