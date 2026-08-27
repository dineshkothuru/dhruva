import { NextResponse } from "next/server";
import { standardsFor, persona, libraryIndex } from "@/lib/standardsLibrary";

/** GET → the full shipped library (read-only browser in the UI). */
export async function GET() {
  return NextResponse.json(await libraryIndex());
}

/** Transparency endpoint: which standards would apply to a set of files.
 * POST {files: string[], persona?: string} → {chars, modules, personaChars} */
export async function POST(req: Request) {
  let b: { files?: unknown; persona?: unknown };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const files = Array.isArray(b.files) ? b.files.filter((f) => typeof f === "string").slice(0, 100) : [];
  const text = await standardsFor(files as string[]);
  const modules = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const p = typeof b.persona === "string" ? await persona(b.persona) : "";
  return NextResponse.json({
    chars: text.length,
    baselineLoaded: text.length > 0,
    modules,
    personaChars: p.length,
  });
}
