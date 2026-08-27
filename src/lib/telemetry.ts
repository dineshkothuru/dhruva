import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";

/** Product analytics - ALWAYS ON once a key is configured.
 *
 * There is no per-user switch: the point is a complete picture of how Dhruva
 * is used, not a self-selected sample. What makes that acceptable is the
 * shape of the data, not a consent dialog:
 *
 *   - The IP address is explicitly discarded ($ip: null), so PostHog stores
 *     no personal data and derives no location.
 *   - An install is identified by a random id generated on the machine. It
 *     maps to no person, org, repository, or customer.
 *   - ALLOWED_PROPS below is the complete list of what may ever be sent.
 *
 * Dhruva runs inside customer Salesforce codebases, often under NDA, so the
 * allowlist is a hard boundary. Adding a field to it is a reviewed decision,
 * never a convenience. If a value could identify a customer, a person, a
 * repository, or a piece of work, it does not belong here.
 *
 * NEVER sent: file paths, project or folder names, org usernames, instance
 * URLs, requirement text, prompts, agent output, findings, code, diffs,
 * error messages, skill contents. Not even hashed - a hashed org name is
 * still a stable identifier for that org.
 *
 * Off switches (for the rare enterprise that contractually forbids any
 * phone-home; nothing in the UI exposes these): DHRUVA_TELEMETRY=0, or the
 * DO_NOT_TRACK=1 convention. A build with no key configured sends nothing. */

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

/** Persisted state is one random id - the minimum needed to count installs
 * rather than events. No consent flag: analytics are not optional per user. */
interface Settings {
  installId?: string;
}

function settingsPath() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfg, "dhruva", "telemetry.json");
}

let cache: Settings | null = null;

async function installId(): Promise<string> {
  if (cache?.installId) return cache.installId;
  try {
    cache = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Settings;
  } catch {
    cache = {};
  }
  if (!cache.installId) {
    cache.installId = randomUUID();
    try {
      await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
      await fs.writeFile(settingsPath(), JSON.stringify(cache, null, 2), "utf8");
    } catch {
      /* a read-only config dir must not break the app - the id just becomes
         per-process, which slightly over-counts installs and nothing worse */
    }
  }
  return cache.installId;
}

/** Environment kill switches. Not surfaced in the UI. */
function envDisabled(): boolean {
  return process.env.DHRUVA_TELEMETRY === "0" || process.env.DO_NOT_TRACK === "1";
}

/** The shipped project token. It is deliberately in the source: a PostHog
 * project token is WRITE-ONLY and public by design (the same value is pasted
 * into public website JavaScript every day). It can send events and nothing
 * else - it cannot read data, list events, or reach the account.
 *
 * Embedding it is what makes analytics work for the people we hand Dhruva
 * to. An env var only ever lives on the machine that set it, so a key read
 * solely from the environment would report the author's own usage and
 * nobody else's - which is the opposite of the point. */
const PROJECT_TOKEN = "phc_siyuME6aW6nXT5TjDuDeUMFCw39MPTuamMRupUFi9Ju5";

function apiKey(): string | undefined {
  return process.env.DHRUVA_POSTHOG_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY || PROJECT_TOKEN;
}

/** Drives the read-only transparency card in Setup. */
export async function telemetryState(): Promise<{
  configured: boolean;
  enabled: boolean;
  envDisabled: boolean;
}> {
  return {
    configured: !!apiKey(),
    enabled: !!apiKey() && !envDisabled(),
    envDisabled: envDisabled(),
  };
}

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (envDisabled()) return null;
  const key = apiKey();
  if (!key) return null;
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

/** Fire-and-forget. Any failure is swallowed: analytics must never affect
 * the product, and a user must never see an error because of it. */
export async function track(event: string, props: TelemetryProps = {}): Promise<void> {
  try {
    const ph = getClient();
    if (!ph) return;
    ph.capture({
      distinctId: await installId(),
      event,
      properties: {
        ...sanitizeProps(props),
        app_version: process.env.npm_package_version ?? "unknown",
        os: process.platform,
        // discard the IP at ingest: no personal data stored, no geo derived
        $ip: null,
        $process_person_profile: false,
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
