import { NextRequest, NextResponse } from "next/server";

/** Network boundary for the API.
 *
 * Dhruva is a single-user local tool with no authentication, so the only
 * thing standing between "the user's own UI" and "any web page in the user's
 * browser / any machine on the LAN" is this check. Two headers close both
 * holes:
 *
 * - Host: a browser reaching us via DNS rebinding (attacker.com resolving to
 *   127.0.0.1) sends its own hostname; a LAN caller sends our LAN IP. Only
 *   loopback names are ours.
 * - Origin: a cross-site fetch/form from a web page carries the page's
 *   origin. Same-origin requests carry ours (or none, for plain
 *   navigations/GETs) - anything else is CSRF.
 *
 * Electron loads the UI from http://localhost:<port>, so legitimate traffic
 * always passes. No token or session is introduced - nothing about the app's
 * own flows changes.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(value: string): string | null {
  try {
    // Host header has no scheme; Origin does. URL() needs a scheme for both.
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host");
  const hostName = host ? hostnameOf(host) : null;
  if (!hostName || !LOOPBACK.has(hostName)) {
    return new NextResponse("Forbidden: Dhruva only answers loopback requests.", { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin) {
    // "null" is a sandboxed/opaque origin - exactly the shape a CSRF iframe
    // sends - so it is rejected like any foreign origin.
    const originName = hostnameOf(origin);
    if (!originName || !LOOPBACK.has(originName)) {
      return new NextResponse("Forbidden: cross-origin requests are not accepted.", {
        status: 403,
      });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
