import { NextResponse } from "next/server";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { isAttachableRoot } from "@/lib/fsguard";

/** Local Dev preview manager — no raw console windows. The UI picks the
 * app/site in a Dhruva modal, the dev server runs hidden here, and its
 * output streams into the panel. One preview per project at a time.
 *
 * POST {path, action:"apps"}                 → {apps:[{name,label}]}
 * POST {path, action:"sites"}                → {sites:[names]}
 * POST {path, action:"start", kind, name}    → {started}
 * POST {path, action:"status"}               → {running, kind, name, logs}
 * POST {path, action:"stop"}                 → {stopped}
 * POST {path, action:"open"}                 → opens the default org */

interface Preview {
  child: ChildProcess;
  kind: string;
  name: string;
  logs: string[];
  /** An interactive yes/no question the CLI is waiting on (bridged to the UI). */
  prompt: string | null;
}
const previews = new Map<string, Preview>(); // key: normalized root

const SAFE_NAME = /^[A-Za-z0-9 _.-]{1,80}$/;

function sfJson(root: string, args: string[]): Promise<{ ok: boolean; out: unknown }> {
  return new Promise((resolve) => {
    execFile(
      "sf",
      args,
      {
        cwd: root,
        timeout: 60_000,
        shell: true,
        windowsHide: true,
        maxBuffer: 20_000_000,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (err, stdout) => {
        try {
          const start = String(stdout).indexOf("{");
          resolve({ ok: !err, out: JSON.parse(String(stdout).slice(start)) });
        } catch {
          resolve({ ok: false, out: null });
        }
      },
    );
  });
}

export async function POST(req: Request) {
  let b: { path?: unknown; action?: unknown; kind?: unknown; name?: unknown };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const root = typeof b.path === "string" ? path.normalize(b.path.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  const key = root.toLowerCase();

  if (b.action === "open") {
    const child = spawn("sf org open", {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: true,
    });
    child.unref();
    return NextResponse.json({ started: true, message: "Opening the default org in your browser…" });
  }

  if (b.action === "apps") {
    const res = await sfJson(root, [
      "data", "query", "-q",
      `"SELECT DeveloperName, Label FROM AppDefinition WHERE UiType='Lightning' ORDER BY Label"`,
      "--json",
    ]);
    const records =
      ((res.out as { result?: { records?: { DeveloperName: string; Label: string }[] } })?.result
        ?.records ?? []) as { DeveloperName: string; Label: string }[];
    return NextResponse.json({
      apps: records
        .filter((r) => r.DeveloperName)
        .map((r) => ({ name: r.DeveloperName, label: r.Label || r.DeveloperName })),
    });
  }

  if (b.action === "sites") {
    const res = await sfJson(root, [
      "data", "query", "-q", `"SELECT Name FROM Network ORDER BY Name"`, "--json",
    ]);
    const records =
      ((res.out as { result?: { records?: { Name: string }[] } })?.result?.records ?? []) as {
        Name: string;
      }[];
    return NextResponse.json({ sites: records.map((r) => r.Name).filter(Boolean) });
  }

  if (b.action === "status") {
    const p = previews.get(key);
    return NextResponse.json({
      running: !!p && p.child.exitCode === null,
      kind: p?.kind ?? null,
      name: p?.name ?? null,
      prompt: p?.prompt ?? null,
      logs: (p?.logs ?? []).slice(-30).join(""),
    });
  }

  if (b.action === "answer") {
    const p = previews.get(key);
    if (!p || p.child.exitCode !== null || !p.prompt) {
      return NextResponse.json({ error: "no pending question" }, { status: 400 });
    }
    const yes = b.name === "yes"; // reuse the name field as the answer carrier
    try {
      p.child.stdin?.write(yes ? "y\n" : "n\n");
      p.logs.push(`\n[you answered: ${yes ? "yes" : "no"}]\n`);
      p.prompt = null;
      return NextResponse.json({ answered: true });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  if (b.action === "stop") {
    const p = previews.get(key);
    if (p?.child.pid) {
      spawn("taskkill", ["/pid", String(p.child.pid), "/T", "/F"], { shell: false });
    }
    previews.delete(key);
    return NextResponse.json({ stopped: true });
  }

  if (b.action === "start") {
    const kind = b.kind === "site" ? "site" : "app";
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!SAFE_NAME.test(name)) {
      return NextResponse.json({ error: "invalid app/site name" }, { status: 400 });
    }
    // one preview per project
    const existing = previews.get(key);
    if (existing?.child.pid) {
      spawn("taskkill", ["/pid", String(existing.child.pid), "/T", "/F"], { shell: false });
      previews.delete(key);
    }
    // pre-answer every interactive prompt — the process runs hidden
    const extra = kind === "app" ? " --device-type desktop" : "";
    const child = spawn(`sf lightning dev ${kind} --name "${name}"${extra}`, {
      cwd: root,
      shell: true,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const p: Preview = { child, kind, name, logs: [], prompt: null };
    const push = (c: Buffer) => {
      const raw = c.toString("utf8");
      // bridge interactive confirms to the UI: "? Question ... (Y/n)"
      const q = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").match(/\?\s+([^\n?]{5,200}?)\s*\((?:Y\/n|y\/N)\)/);
      if (q) p.prompt = q[1].trim();
      const text = c
        .toString("utf8")
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        // drop the CLI's harmless dev-plugin probe noise from the panel log
        .split("\n")
        .filter(
          (l) =>
            !/Error Plugin: @salesforce\/cli|could not find package\.json|^\s*(name|root|type|module|plugin):|See more details with DEBUG|trace-warnings|^\s*}\s*$|^\s*{\s*$/.test(
              l,
            ),
        )
        .join("\n");
      if (text.trim()) p.logs.push(text);
      if (p.logs.length > 200) p.logs.splice(0, p.logs.length - 200);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.stdin?.on("error", () => {});
    child.on("close", () => {
      /* keep logs for status; entry removed on stop/new start */
    });
    previews.set(key, p);
    return NextResponse.json({ started: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
