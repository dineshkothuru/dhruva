import { NextResponse } from "next/server";
import path from "node:path";
import { detectProject } from "@/lib/detect";
import { sfOrgDisplay } from "@/lib/sfcli";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const b = body as { path?: unknown; skipOrg?: unknown; orgOnly?: unknown };
  const p = b?.path;
  if (typeof p !== "string" || p.length === 0 || p.length > 500) {
    return NextResponse.json({ error: "path (string) is required" }, { status: 400 });
  }
  if (!path.isAbsolute(p.trim())) {
    return NextResponse.json(
      { error: "Provide an absolute folder path (e.g. D:\\my-sf-project)" },
      { status: 400 },
    );
  }

  // Second phase of a two-phase connect: just the (slow) org badge.
  if (b.orgOnly === true) {
    return NextResponse.json({ org: await sfOrgDisplay(path.normalize(p.trim())) });
  }

  const result = await detectProject(p, { skipOrg: b.skipOrg === true });
  return NextResponse.json(result);
}
