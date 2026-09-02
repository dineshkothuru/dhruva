import { promises as fs } from "node:fs";
import path from "node:path";
import { parseSfJson, runSf } from "@/lib/orgMetadata";
import { packageDirs, splitPackagePath } from "@/lib/org/comparePaths";

/** Deploy ONE file's component to the connected org.
 *
 * This is the only WRITE-to-org path Dhruva offers outside a gated workflow,
 * and that is worth stating plainly rather than burying.
 *
 * Everything else that deploys does so as a workflow step, behind a `gate`
 * step that a human has to clear - src/lib/workflows/validate.ts refuses to
 * accept a workflow whose `deploy start` has no gate before it, and AGENTS.md
 * says "human gates before deploys". A button in the editor bypasses that
 * machinery entirely.
 *
 * So the button carries its own gate, and it has to be a real one:
 *
 *  - The caller must confirm, and the confirmation names the ORG USERNAME and
 *    the exact component. "Deploy?" with no target named is not a gate; the
 *    whole failure mode being guarded against is deploying to the wrong org.
 *  - `checkOnly` runs sf's --dry-run: the org compiles and validates but saves
 *    nothing. The UI offers it first, because "will this even compile there?"
 *    is the question people actually have.
 *  - Refused while a workflow run is active. A run measures the working tree
 *    and may be about to deploy it itself.
 *  - Deploys stay on the `sf` CLI deliberately. Reads moved in-process for
 *    speed, but a write is exactly where the CLI's audit trail and its own
 *    conflict handling are worth the six seconds of startup - and it keeps the
 *    "whitelisted binaries only" guardrail intact for the dangerous direction.
 *
 * It deploys the COMPONENT, not the byte range: sf resolves an LWC .js to its
 * whole bundle, which is correct - a bundle is not deployable in pieces. */

export interface DeployOutcome {
  ok: boolean;
  /** True when this was a validation only and nothing was saved to the org. */
  checkOnly: boolean;
  /** sf's own words - kept verbatim, because a deploy failure is a compile
   * error or a test failure and paraphrasing it loses the line number. */
  message: string;
  /** Per-component results sf reported. */
  files: { fullName?: string; type?: string; state?: string; error?: string }[];
  /** The deploy id, so a user can find it in Setup > Deployment Status. */
  deployId?: string;
  /** Number of components sf reported deploying. */
  componentCount?: number;
}

/** Reject anything that could be read by a shell.
 *
 * runSf goes through a shell on Windows, and this path is user-chosen. The
 * same gate the per-file retrieve uses - and the reason it is a rejection
 * rather than an escape is that `%` alone makes cmd.exe interpolate, whatever
 * the quoting. */
export function deployablePath(rel: string): boolean {
  if (!rel || rel.length > 400) return false;
  return !/["'`^&|<>%$;\r\n\t*?]/.test(rel);
}

export async function deployFile(
  root: string,
  rel: string,
  opts: { checkOnly?: boolean; timeoutMs?: number } = {},
): Promise<DeployOutcome> {
  const checkOnly = opts.checkOnly === true;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  if (!deployablePath(rel)) {
    return { ok: false, checkOnly, message: "invalid characters in path", files: [] };
  }

  const split = splitPackagePath(rel, await packageDirs(root));
  if (!split) {
    return {
      ok: false,
      checkOnly,
      message: "not inside a package directory - only metadata can be deployed",
      files: [],
    };
  }

  if (!(await fs.stat(path.join(root, rel)).catch(() => null))) {
    return { ok: false, checkOnly, message: "file not found on disk", files: [] };
  }

  const waitMinutes = Math.max(3, Math.ceil(timeoutMs / 60_000));
  const args = [
    "project",
    "deploy",
    "start",
    "--source-dir",
    `"${rel}"`,
    "--json",
    "--wait",
    String(waitMinutes),
  ];
  if (checkOnly) args.push("--dry-run");

  // The process timeout must OUTLIVE sf's own --wait (plus its ~6s boot):
  // killing the wrapper first orphans the sf process, whose org-side deploy
  // completes anyway - while this function reported "failed".
  const { stdout, stderr, ok } = await runSf(args, root, waitMinutes * 60_000 + 60_000);
  if (!ok && !stdout.trim()) {
    // killed or died without output: the org-side outcome is UNKNOWN, and
    // claiming failure here is how a "failed" deploy ends up live in the org
    return {
      ok: false,
      checkOnly,
      message:
        "deploy outcome unknown - the CLI was interrupted before reporting. " +
        "Check Setup → Deployment Status in the org before retrying.",
      files: [],
    };
  }
  const parsed = parseSfJson(stdout);
  const result = parsed?.result ?? parsed;

  const raw: unknown = result?.files ?? result?.details?.componentFailures ?? [];
  const files = (Array.isArray(raw) ? raw : []).slice(0, 100).map((f: unknown) => {
    const r = (f ?? {}) as Record<string, unknown>;
    return {
      fullName: typeof r.fullName === "string" ? r.fullName : undefined,
      type: typeof r.type === "string" ? r.type : undefined,
      state: typeof r.state === "string" ? r.state : undefined,
      error: typeof r.error === "string" ? r.error : undefined,
    };
  });

  // sf reports success two ways depending on version; trust the explicit
  // status field first and fall back to the exit code.
  const succeeded =
    result?.status === "Succeeded" ||
    result?.success === true ||
    (ok && parsed?.status === 0 && !files.some((f) => f.state === "Failed"));

  if (!succeeded) {
    const msg =
      files.find((f) => f.error)?.error ??
      (typeof result?.message === "string" ? result.message : "") ??
      "";
    return {
      ok: false,
      checkOnly,
      message: String(msg || (stderr || stdout).slice(-800) || "deploy failed"),
      files,
      deployId: typeof result?.id === "string" ? result.id : undefined,
    };
  }

  return {
    ok: true,
    checkOnly,
    message: checkOnly
      ? "Validated against the org - nothing was saved."
      : "Deployed to the org.",
    files,
    deployId: typeof result?.id === "string" ? result.id : undefined,
    componentCount:
      typeof result?.numberComponentsDeployed === "number"
        ? result.numberComponentsDeployed
        : undefined,
  };
}
