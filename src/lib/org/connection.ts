import { promises as fs } from "node:fs";
import path from "node:path";

/** An in-process connection to the project's org, reusing the Salesforce CLI's
 * own authentication.
 *
 * WHY THIS EXISTS - the numbers, measured on a real project:
 *
 *   sf --version .................... 6.0s   (pure process boot, no work)
 *   sf config get target-org ........ 8.9s   (boot + reading one local file)
 *   sf project retrieve (1 class) ... 12.9s
 *
 * versus the same work in this process:
 *
 *   Connection (first, per process) .. 3.2s   (once, then reused)
 *   Connection (subsequent) .......... 0.36s
 *   Apex class body .................. 0.30s
 *   whole LWC bundle ................. 0.40s
 *   metadata.describe() .............. 0.60s
 *
 * About nine of the CLI's fifteen seconds is the CLI starting up. No amount of
 * caching or batching removes that while a process spawn is the transport, so
 * the read paths stop spawning.
 *
 * WHAT THIS CHANGES ABOUT CREDENTIALS - read this before extending it.
 *
 * Dhruva's stated posture has been that it never sees a credential: every org
 * operation went through `sf`, which held the tokens. That is no longer
 * literally true here. @salesforce/core reads the SAME files the CLI wrote
 * (~/.sf), refreshes the access token itself, and the token therefore lives in
 * this process's memory for the lifetime of the connection.
 *
 * What has NOT changed: Dhruva still never asks for a credential, never writes
 * one, never stores one of its own, and never sends one anywhere except to the
 * Salesforce instance it was issued for. Logging in remains the CLI's job -
 * `sf org login web` owns the browser OAuth flow, and nothing here can create
 * an authentication that the CLI did not already establish.
 *
 * The honest summary is "Dhruva reuses the CLI's login in-process for reads",
 * not "Dhruva never sees a credential", and the README and AGENTS.md wording
 * should say so. */

/** Connections are expensive to build (3.2s) and cheap to reuse (0.36s), so
 * one is kept per project. Held on globalThis so a dev-mode module reload does
 * not silently start paying that cost again on every edit. */
interface Cached {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: any;
  username: string;
  /** the project's target-org alias this connection was built for */
  target: string;
  at: number;
}
const store = globalThis as unknown as { __dhruvaOrgConn?: Map<string, Cached> };
const conns: Map<string, Cached> = (store.__dhruvaOrgConn ??= new Map());

/** Rebuild a connection after this long, so a long-running app does not sit on
 * a stale token forever. Refresh is handled inside the connection, so this is
 * only a backstop. */
const CONN_TTL_MS = 30 * 60_000;

export interface OrgConnection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: any;
  username: string;
}

/** The org this project is attached to, or null.
 *
 * Only a PROJECT-LOCAL target-org counts, matching what sfcli.ts already
 * enforces: without that check the machine-wide default would be used, which
 * is an org the user never authorised for this project. */
async function projectTargetOrg(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, ".sf", "config.json"), "utf8");
    const v = JSON.parse(raw)?.["target-org"];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Get (or build) the connection for a project.
 *
 * Never throws: an unauthenticated project is a normal state in this app, and
 * every caller has a CLI-based fallback to fall through to. */
export async function getOrgConnection(
  root: string,
): Promise<{ ok: true; org: OrgConnection } | { ok: false; reason: string }> {
  const target = await projectTargetOrg(root);
  if (!target) return { ok: false, reason: "no org authorized for this project" };

  const hit = conns.get(root);
  if (hit && Date.now() - hit.at < CONN_TTL_MS) {
    // A cache hit is only valid for the org the project points at NOW. The
    // config re-read costs one small file read; serving a stale connection
    // after `sf config set target-org` made the deploy confirmation name the
    // OLD org while the CLI deployed to the new one.
    if (hit.target === target) {
      return { ok: true, org: { conn: hit.conn, username: hit.username } };
    }
    conns.delete(root);
  }

  try {
    // Imported here rather than at module load: @salesforce/core is a heavy
    // dependency and a project with no org attached should never pay for it.
    const core = await import("@salesforce/core");
    const agg = await core.StateAggregator.getInstance();
    // The project stores an alias ("devp2"); AuthInfo needs the username.
    const username = agg.aliases.getUsername(target) ?? target;
    const authInfo = await core.AuthInfo.create({ username });
    const conn = await core.Connection.create({ authInfo });
    conns.set(root, { conn, username, target, at: Date.now() });
    return { ok: true, org: { conn, username } };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "could not connect to the org",
    };
  }
}

/** Forget a project's connection - after a login, or when a call fails in a way
 * that suggests the token is no longer usable. */
export function dropOrgConnection(root: string) {
  conns.delete(root);
}
