import { NextResponse } from "next/server";
import { telemetryState } from "@/lib/telemetry";

/** Read-only transparency endpoint. Analytics are always on when a backend
 * is configured, so there is nothing for a user to set here - this exists so
 * the Setup tab can show what the current state actually is. */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (b.action === "state") return NextResponse.json(await telemetryState());
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
