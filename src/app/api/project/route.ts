import { NextResponse } from "next/server";
import path from "node:path";
import { detectProject } from "@/lib/detect";
import { sfOrgDisplay } from "@/lib/sfcli";
import { getOrgConnection } from "@/lib/org/connection";

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
    const root = path.normalize(p.trim());
    const org = await sfOrgDisplay(root);
    // Warm the in-process connection while the user is still reading the badge.
    //
    // Building it costs a few seconds once and then answers in ~0.3s, so
    // whoever pays for it pays a lot. Left cold, that bill lands on the first
    // Compare with org - which is exactly the click that used to take fifteen
    // seconds and is the reason any of this exists. Fire-and-forget: it is a
    // read, its failure mode is "the first compare is slower", and the badge
    // response must not wait for it.
    if (org.connected) void getOrgConnection(root).catch(() => {});
    return NextResponse.json({ org });
  }

  const result = await detectProject(p, { skipOrg: b.skipOrg === true });
  return NextResponse.json(result);
}
