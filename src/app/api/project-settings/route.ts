import { NextResponse } from "next/server";
import path from "node:path";
import { isAttachableRoot } from "@/lib/fsguard";
import { readProjectSettings, writeProjectSettings, type ProjectSettings } from "@/lib/projectSettings";

/** Per-project settings (.sfharness/settings.json).
 * POST {root}            → current settings
 * POST {root, settings}  → validate + save, returns the stored settings */
export async function POST(req: Request) {
  let b: { root?: unknown; settings?: unknown };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const root = typeof b.root === "string" ? path.normalize(b.root.trim()) : "";
  if (!root || !(await isAttachableRoot(root))) {
    return NextResponse.json({ error: "not an attached Salesforce project" }, { status: 400 });
  }
  if (b.settings && typeof b.settings === "object") {
    const s = b.settings as ProjectSettings;
    const clean: ProjectSettings = {};
    if (s.ux && typeof s.ux === "object") {
      const dir = typeof s.ux.designDir === "string" ? s.ux.designDir.trim() : "";
      clean.ux = {
        enabled: s.ux.enabled === true,
        designDir: dir && !dir.includes("..") && !path.isAbsolute(dir) ? dir.slice(0, 200) : "docs/design",
        rules: typeof s.ux.rules === "string" ? s.ux.rules.slice(0, 4000) : "",
      };
    }
    await writeProjectSettings(root, clean);
    return NextResponse.json({ settings: clean });
  }
  return NextResponse.json({ settings: await readProjectSettings(root) });
}
