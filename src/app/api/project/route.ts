import { NextResponse } from "next/server";
import path from "node:path";
import { detectProject } from "@/lib/detect";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const p = (body as { path?: unknown })?.path;
  if (typeof p !== "string" || p.length === 0 || p.length > 500) {
    return NextResponse.json({ error: "path (string) is required" }, { status: 400 });
  }
  if (!path.isAbsolute(p.trim())) {
    return NextResponse.json(
      { error: "Provide an absolute folder path (e.g. D:\\my-sf-project)" },
      { status: 400 },
    );
  }

  const result = await detectProject(p);
  return NextResponse.json(result);
}
