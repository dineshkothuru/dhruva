import { execFile } from "node:child_process";

/** Best-effort `sf org display --json` in the given project folder.
 * Never throws — an unusable sf CLI or missing org is a normal outcome. */
export async function sfOrgDisplay(cwd: string): Promise<{
  connected: boolean;
  username?: string;
  instanceUrl?: string;
  reason?: string;
}> {
  // Only honor a PROJECT-LOCAL default org. Without this check, `sf org
  // display` silently falls back to the machine-wide global default, which
  // would show an org the user never authorized for this project.
  const cfg = await run("sf", ["config", "get", "target-org", "--json"], cwd);
  const cfgParsed = parseJson(cfg.stdout);
  const entry = Array.isArray(cfgParsed?.result) ? cfgParsed.result[0] : undefined;
  if (!entry?.value) {
    if (cfg.error && (cfg.error.includes("ENOENT") || cfg.error.includes("not recognized"))) {
      return { connected: false, reason: "Salesforce CLI (sf) not installed" };
    }
    return { connected: false, reason: "no org authorized for this project" };
  }
  if (entry.location !== "Local") {
    return {
      connected: false,
      reason: `no org authorized for this project (machine default: ${entry.value})`,
    };
  }

  const { stdout, error } = await run("sf", ["org", "display", "--json"], cwd);
  if (error && !stdout) {
    if (error.includes("ENOENT") || error.includes("not recognized")) {
      return { connected: false, reason: "Salesforce CLI (sf) not installed" };
    }
    if (error.includes("timed out")) {
      return { connected: false, reason: "sf CLI timed out" };
    }
  }
  try {
    const parsed = parseJson(stdout);
    if (!parsed) throw new Error("no JSON in output");
    if (parsed.status === 0 && parsed.result?.username) {
      return {
        connected: true,
        username: parsed.result.username,
        instanceUrl: parsed.result.instanceUrl,
      };
    }
    return {
      connected: false,
      reason: parsed.message ?? parsed.name ?? "no default org authorized",
    };
  } catch {
    console.error("[sfcli] unparseable sf output", { error, head: stdout.slice(0, 200) });
    return { connected: false, reason: error ?? "unexpected sf CLI output" };
  }
}

/** Parse sf's JSON output: strip ANSI color codes (sf colorizes when
 * FORCE_COLOR is set — Next's dev server sets it) and skip any plain-text
 * prefix lines (e.g. a CLI update warning) before the first "{". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJson(stdout: string): any | null {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const jsonStart = clean.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(clean.slice(jsonStart));
  } catch {
    return null;
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    // shell:true so Windows resolves sf.cmd; args are fixed strings, cwd is
    // a validated directory path passed as an option (not interpolated).
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: 30_000,
        shell: true,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (err, stdout) => {
        resolve({ stdout: stdout ?? "", error: err ? String(err.message) : undefined });
      },
    );
  });
}
