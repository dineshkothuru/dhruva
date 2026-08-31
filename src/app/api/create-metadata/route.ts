import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot } from "@/lib/fsguard";
import { hasActiveRun } from "@/lib/workflows/engine";
import { packageDirs } from "@/lib/orgCompare";
import { CREATE_TYPES, createMetadata, type CreateRequest } from "@/lib/createMetadata";

/** Create a new metadata component from a Salesforce template.
 * GET  → {types, packageDirs} - what the New dialog offers
 * POST {root, type, name, ...} → {ok, created, primary}
 *
 * Local scaffolding only: no org call, no deploy, no credential. The write is
 * new files under a package directory, and it refuses to overwrite. */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const root = typeof body.root === "string" ? path.normalize(body.root.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }

  // A run measures the working tree it is running against, and new files would
  // land in that run's own change list. Same reason compare and retrieve pause.
  if (hasActiveRun(root)) {
    return NextResponse.json(
      { error: "a workflow run is in progress - creating files is paused until it finishes" },
      { status: 409 },
    );
  }

  const result = await createMetadata(root, body as unknown as CreateRequest);
  if (!result.ok) {
    // A rejected name or a duplicate is the user's input, not a server fault -
    // 400 so the dialog shows it inline rather than as a failure banner.
    return NextResponse.json({ error: result.error ?? "could not create" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, created: result.created, primary: result.primary });
}

/** The dialog's menu, built from the same table the POST validates against, so
 * the two can never drift apart. */
export async function GET(req: Request) {
  const root = new URL(req.url).searchParams.get("root") ?? "";
  const norm = root ? path.normalize(root.trim()) : "";
  const dirs = norm && (await isAttachableRoot(norm)) ? await packageDirs(norm) : [];
  return NextResponse.json({
    types: CREATE_TYPES.map((t) => ({
      id: t.id,
      label: t.label,
      group: t.group,
      dir: t.dir,
      templates: t.templates,
      needs: t.needs,
      nameStyle: t.nameStyle,
    })),
    packageDirs: dirs,
  });
}
