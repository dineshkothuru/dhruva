import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";

/** Product telemetry - OFF until the user explicitly turns it on.
 *
 * Dhruva runs inside customer Salesforce codebases, often under NDA. That
 * makes silent telemetry unacceptable, so this module is built around one
 * rule: NOTHING derived from the customer's project ever leaves the machine.
 *
 * The allowlist below is the whole contract. Adding a field to it is a
 * deliberate decision, reviewed like any other change - never a convenience.
 * If a value could identify a customer, a person, a repository, or a piece of
 * work, it does not belong here.
 *
 * NEVER sent: file paths, project or folder names, org usernames, instance
 * URLs, requirement text, prompts, agent output, findings, code, diffs,
 * error messages, skill contents. Not even hashed - a hashed org name is
 * still a stable identifier for that org.
 *
 * Off switches, any one of which wins: the stored opt-in being absent or
 * false, DHRUVA_TELEMETRY=0, or the DO_NOT_TRACK=1 convention. */

const HOST = "https://us.i.posthog.com";

/** Every property that may be transmitted. Anything else is dropped. */
const ALLOWED_PROPS = new Set([
  "app_version", // which release
  "os", // win32 | darwin | linux
  "workflow_id", // "solution-design" - shipped ids only, see sanitizeProps
  "workflow_custom", // true when the id was a user's custom workflow (id NOT sent)
  "step_type", // snapshot | agent | cli | gate | changes | verify | tasks-check
  "step_role", // read | design | implement | review | trace
  "agent", // copilot | claude | codex | cursor
  "model_tier", // best | default | light
  "outcome", // done | failed | aborted
  "error_class", // "timeout" | "cli_missing" - a CLASS, never a message
  "duration_bucket", // "1-5m" - bucketed, never a raw timing
  "step_count",
  "chained", // was this run part of a workflow chain
  "unattended", // was the AI gatekeeper resolving gates
  "gate_decision", // approve | revise | abort | escalate
  "feature", // which UI feature was used, from a fixed vocabulary
]);

/** Shipped workflow ids may be transmitted; a custom workflow's id could
 * carry a customer name ("acme-migration"), so only the FACT of a custom
 * workflow is reported. */
const SHIPPED_WORKFLOWS = new Set([
  "bug-fix",
  "feature-dev",
  "solution-design",
  "ux-design",
  "implement-tdd",
  "test-gen",
  "run-tests",
  "retrieve-sync",
  "deploy-preview",
  "validate-deploy",
  "scratch-org",
]);

export type TelemetryProps = Record<string, string | number | boolean | undefined>;

interface Settings {
  /** true only after the user opts in; undefined means "never asked". */
  enabled?: boolean;
  /** random, generated locally - identifies an INSTALL, never a person. */
  installId?: string;
  /** so a future version can re-ask if the policy changes. */
  askedVersion?: string;
}

function settingsPath() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfg, "dhruva", "telemetry.json");
}

let cache: Settings | null = null;

export async function readSettings(): Promise<Settings> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Settings;
  } catch {
    cache = {};
  }
  return cache;
}

export async function writeSettings(next: Settings): Promise<Settings> {
  const merged: Settings = { ...(await readSettings()), ...next };
  if (merged.enabled && !merged.installId) merged.installId = randomUUID();
  try {
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(merged, null, 2), "utf8");
  } catch {
    /* a read-only config dir must not break the app */
  }
  cache = merged;
  if (!merged.enabled) await shutdown(); // stop immediately on opt-out
  return merged;
}

/** Environment kill switches beat any stored preference. */
function envDisabled(): boolean {
  return process.env.DHRUVA_TELEMETRY === "0" || process.env.DO_NOT_TRACK === "1";
}

/** No key configured = the build simply has no telemetry backend. */
function apiKey(): string | undefined {
  return process.env.DHRUVA_POSTHOG_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY || undefined;
}

/** Has the user been asked yet? Drives the one-time opt-in prompt. */
export async function telemetryState(): Promise<{
  configured: boolean;
  asked: boolean;
  enabled: boolean;
  envDisabled: boolean;
}> {
  const s = await readSettings();
  return {
    configured: !!apiKey(),
    asked: s.enabled !== undefined,
    enabled: s.enabled === true && !envDisabled(),
    envDisabled: envDisabled(),
  };
}

let client: PostHog | null = null;

async function getClient(): Promise<PostHog | null> {
  if (envDisabled()) return null;
  const key = apiKey();
  if (!key) return null;
  const s = await readSettings();
  if (s.enabled !== true) return null;
  if (!client) {
    client = new PostHog(key, {
      host: process.env.DHRUVA_POSTHOG_HOST || HOST,
      flushAt: 10,
      flushInterval: 30_000,
    });
  }
  return client;
}

/** Drop anything not on the allowlist, and never let a custom workflow id
 * through. Defensive on purpose: a future caller passing extra context does
 * not get to leak it. */
export function sanitizeProps(props: TelemetryProps): TelemetryProps {
  const out: TelemetryProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (!ALLOWED_PROPS.has(k) || v === undefined) continue;
    if (k === "workflow_id") {
      const id = String(v);
      if (SHIPPED_WORKFLOWS.has(id)) out.workflow_id = id;
      else out.workflow_custom = true;
      continue;
    }
    out[k] = typeof v === "string" ? v.slice(0, 60) : v;
  }
  return out;
}

/** Raw durations can fingerprint a specific run; buckets cannot. */
export function durationBucket(ms: number): string {
  const m = ms / 60_000;
  if (m < 1) return "<1m";
  if (m < 5) return "1-5m";
  if (m < 15) return "5-15m";
  if (m < 45) return "15-45m";
  return ">45m";
}

/** Fire-and-forget. Any failure is swallowed: telemetry must never affect
 * the product, and a user must never see an error because of it. */
export async function track(event: string, props: TelemetryProps = {}): Promise<void> {
  try {
    const ph = await getClient();
    if (!ph) return;
    const s = await readSettings();
    if (!s.installId) return;
    ph.capture({
      distinctId: s.installId,
      event,
      properties: {
        ...sanitizeProps(props),
        app_version: process.env.npm_package_version ?? "unknown",
        os: process.platform,
        $process_person_profile: false, // no person profiles, no IP-derived geo
      },
    });
  } catch {
    /* never surfaces */
  }
}

export async function shutdown(): Promise<void> {
  try {
    await client?.shutdown();
  } catch {
    /* ignore */
  }
  client = null;
}
