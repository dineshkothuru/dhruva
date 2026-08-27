import { NextResponse } from "next/server";
import { telemetryState, writeSettings } from "@/lib/telemetry";

/** Telemetry consent plane.
 * POST {action:"state"}          → whether a backend is configured, whether
 *                                  the user has been asked, current setting
 * POST {action:"set", enabled}   → record the user's choice */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (b.action === "state") {
    return NextResponse.json(await telemetryState());
  }

  if (b.action === "set") {
    if (typeof b.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    await writeSettings({ enabled: b.enabled });
    return NextResponse.json(await telemetryState());
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
