"use client";

/** Client-side helper: reports a UI event through the server, which applies
 * the allowlist. Fire-and-forget and failure-silent - analytics must never
 * change what the user sees or block anything they are doing. */
export function trackUi(event: string, props: Record<string, string | boolean> = {}) {
  try {
    void fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, props }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never surfaces */
  }
}
