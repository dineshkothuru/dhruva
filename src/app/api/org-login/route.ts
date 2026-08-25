import { NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

/** Launch `sf org login web` for the given project folder. The Salesforce
 * login page opens in the user's own browser — credentials never pass
 * through this app; the sf CLI captures the OAuth token when they finish.
 * Fire-and-forget: the UI re-runs detection afterwards to see the result. */
export async function POST(req: Request) {
  let body: { path?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const p = body.path;
  if (typeof p !== "string" || !path.isAbsolute(p.trim())) {
    return NextResponse.json({ error: "absolute path required" }, { status: 400 });
  }
  const projectPath = path.normalize(p.trim());

  const stat = await fs.stat(projectPath).catch(() => null);
  if (!stat?.isDirectory()) {
    return NextResponse.json({ error: "folder not found" }, { status: 400 });
  }

  // Always open the standard login host; sandboxes and my-domain orgs are
  // reached via the login page's "Use Custom Domain" option.
  const args = [
    "org",
    "login",
    "web",
    "--set-default",
    "--instance-url",
    "https://login.salesforce.com",
  ];

  try {
    const child = spawn("sf", args, {
      cwd: projectPath,
      shell: true,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    child.unref();
  } catch (e) {
    return NextResponse.json({ error: `could not start sf CLI: ${String(e)}` }, { status: 500 });
  }

  return NextResponse.json({
    started: true,
    message: "Salesforce login opened in your browser. Finish logging in there, then click Refresh.",
  });
}
