import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot, resolveInside } from "@/lib/fsguard";
import { hasActiveRun } from "@/lib/workflows/engine";
import { deployFile } from "@/lib/org/deployFile";
import { sfOrgDisplay } from "@/lib/sfcli";

/** Deploy one file's component to the connected org.
 * POST {root, file, checkOnly, confirmOrg} → {ok, checkOnly, message, files}
 * GET  ?root=... → {org} - who a deploy would go to, for the confirmation
 *
 * The ONLY write-to-org path outside a gated workflow. Three things make that
 * defensible, and all three are enforced here rather than in the UI:
 *
 *  1. `confirmOrg` must match the org actually attached. The client sends back
 *     the username it showed the user, and a mismatch is refused. Without it,
 *     a stale dialog could deploy to an org the user was never shown - and
 *     "deployed to the wrong org" is the failure this whole feature has to be
 *     built around. A UI-only confirmation is not a gate; this is.
 *  2. Refused while a workflow run is active.
 *  3. `checkOnly` is honoured verbatim, so the validate path cannot
 *     accidentally save. */
export async function POST(req: Request) {
  let body: {
    root?: unknown;
    file?: unknown;
    checkOnly?: unknown;
    confirmOrg?: unknown;
  };
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

  // A run measures the working tree and may be about to deploy it itself.
  if (hasActiveRun(root)) {
    return NextResponse.json(
      { error: "a workflow run is in progress - deploying is paused until it finishes" },
      { status: 409 },
    );
  }

  const org = await sfOrgDisplay(root);
  if (!org.connected || !org.username) {
    return NextResponse.json(
      { error: org.reason ?? "no org authorized for this project" },
      { status: 400 },
    );
  }

  // The confirmation the user actually saw has to match where this is going.
  const confirmOrg = typeof body.confirmOrg === "string" ? body.confirmOrg.trim() : "";
  if (!confirmOrg) {
    return NextResponse.json(
      { error: "a deploy must be confirmed against a named org" },
      { status: 400 },
    );
  }
  if (confirmOrg !== org.username) {
    return NextResponse.json(
      {
        error: `this project is now connected to ${org.username}, not ${confirmOrg} - reopen the dialog and confirm again`,
      },
      { status: 409 },
    );
  }

  const out = await deployFile(root, rel, { checkOnly: body.checkOnly === true });
  return NextResponse.json({ ...out, org: org.username }, { status: out.ok ? 200 : 400 });
}

/** Who a deploy from this project would go to. The dialog names it before the
 * user can confirm, and sends it back as confirmOrg. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("root") ?? "";
  const root = raw ? path.normalize(raw.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  return NextResponse.json({ org: await sfOrgDisplay(root) });
}
