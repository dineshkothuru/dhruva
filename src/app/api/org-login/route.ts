import { NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

/** Launch `sf org login web` for the given project folder. The Salesforce
 * login page opens in the user's own browser — credentials never pass
 * through this app; the sf CLI captures the OAuth token when they finish.
 * Fire-and-forget: the UI re-runs detection afterwards to see the result. */
export async function POST(req: Request) {
  let body: { path?: unknown; instanceUrl?: unknown };
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

  // The login host MUST match where the user authenticates: a sandbox login
  // through login.salesforce.com fails the auth-code exchange with
  // invalid_grant. Reuse the org's known instance URL when we have it;
  // otherwise the UI passes sandbox (test) or production (login).
  const raw = typeof body.instanceUrl === "string" ? body.instanceUrl.trim() : "";
  const okHost =
    /^https:\/\/(login|test)\.salesforce\.com$/.test(raw) ||
    /^https:\/\/[a-z0-9][a-z0-9.-]*\.my\.salesforce\.com$/i.test(raw);
  const instanceUrl = okHost ? raw : "https://test.salesforce.com";
  const args = ["org", "login", "web", "--set-default", "--instance-url", instanceUrl];

  try {
    // NOT detached: on Windows a detached child gets its own console that
    // ignores windowsHide — attached+hidden means the user sees only the
    // browser tab the CLI opens. The command exits by itself after login.
    const child = spawn("sf", args, {
      cwd: projectPath,
      shell: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    child.on("error", () => {});
    child.unref();
  } catch (e) {
    return NextResponse.json({ error: `could not start sf CLI: ${String(e)}` }, { status: 500 });
  }

  return NextResponse.json({
    started: true,
    message: "Salesforce login opened in your browser — this panel updates automatically when you finish.",
  });
}
