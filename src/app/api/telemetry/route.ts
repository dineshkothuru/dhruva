import { NextResponse } from "next/server";
import { CLIENT_EVENTS, track } from "@/lib/telemetry";

/** Lets the UI report the handful of events only the browser can observe -
 * the app opening, a project being attached, a tool being used.
 *
 * The browser is not trusted with what gets sent: the event name must be in
 * CLIENT_EVENTS, and the properties still pass through the same allowlist as
 * every server-side event, so nothing extra can ride along from the client. */
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (typeof b.event !== "string" || !CLIENT_EVENTS.has(b.event)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const props =
    b.props && typeof b.props === "object" ? (b.props as Record<string, never>) : {};
  void track(b.event, props);
  return NextResponse.json({ ok: true });
}
