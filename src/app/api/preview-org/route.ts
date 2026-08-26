import { NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "node:child_process";
import { isAttachableRoot } from "@/lib/fsguard";

/** Launch Salesforce Local Dev for the attached project: opens the org in
 * the browser with LOCAL LWC files rendered live against REAL org data
 * (no deploy). Runs `sf lightning dev app` in a visible console window the
 * user can watch and close — it is a long-lived dev server, not a step.
 * Note: only UI components are virtualized; Apex still runs org-side. */
export async function POST(req: Request) {
  let body: { path?: unknown; kind?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const root = typeof body.path === "string" ? path.normalize(body.path.trim()) : "";
  // "app" = Lightning app preview; "site" = LWR Experience Cloud site preview
  const kind = body.kind === "site" ? "site" : "app";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }

  try {
    // visible console so the user sees the dev-server status/prompts and can
    // stop it; detached so this request returns immediately
    // single shell string: node's arg-quoting breaks `start`'s title parsing
    const child = spawn(`start "DhruvaLocalDev" cmd /k "sf lightning dev ${kind}"`, {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      shell: true,
    });
    child.unref();
  } catch (e) {
    return NextResponse.json({ error: `could not start Local Dev: ${String(e)}` }, { status: 500 });
  }

  return NextResponse.json({
    started: true,
    message:
      "Local Dev is starting in a console window. Pick the Lightning app when prompted — the org opens in your browser with your LOCAL component files rendered against REAL org data (hot reload on save). Apex changes are not previewed (server-side) — use a scratch org or deploy for those. First time: enable Local Dev in Setup → Local Dev, and `sf plugins install @salesforce/plugin-lightning-dev`.",
  });
}
