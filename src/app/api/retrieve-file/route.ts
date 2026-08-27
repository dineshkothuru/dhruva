import { NextResponse } from "next/server";
import path from "node:path";
import { execFile } from "node:child_process";
import { isAttachableRoot, resolveInside } from "@/lib/fsguard";

/** Retrieve ONE source file fresh from the connected org (the VS Code
 * "SFDX: Retrieve Source from Org" parity for the editor).
 * POST {root, file} → {ok, output} */
export async function POST(req: Request) {
  let body: { root?: unknown; file?: unknown };
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
  // shell reaches cmd.exe - keep the arg free of metacharacters
  if (/["'`^&|<>%$;\r\n\t]/.test(rel)) {
    return NextResponse.json({ error: "invalid characters in path" }, { status: 400 });
  }

  const output = await new Promise<{ ok: boolean; text: string }>((resolve) => {
    execFile(
      "sf",
      ["project", "retrieve", "start", "--source-dir", `"${rel}"`, "--json", "--wait", "10"],
      {
        cwd: root,
        timeout: 120_000,
        shell: true,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) =>
        resolve({ ok: !err, text: (stdout || stderr || "").slice(-2000) }),
    );
  });

  if (!output.ok) {
    return NextResponse.json({ error: `retrieve failed: ${output.text}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, output: output.text });
}
