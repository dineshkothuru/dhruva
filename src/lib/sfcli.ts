import { execFile } from "node:child_process";

/** Best-effort `sf org display --json` in the given project folder.
 * Never throws — an unusable sf CLI or missing org is a normal outcome. */
export async function sfOrgDisplay(cwd: string): Promise<{
  connected: boolean;
  username?: string;
  instanceUrl?: string;
  reason?: string;
}> {
  const { stdout, error } = await run("sf", ["org", "display", "--json"], cwd);
  if (error && !stdout) {
    if (error.includes("ENOENT") || error.includes("not recognized")) {
      return { connected: false, reason: "Salesforce CLI (sf) not installed" };
    }
    if (error.includes("timed out")) {
      return { connected: false, reason: "sf CLI timed out" };
    }
  }
  // sf prints JSON on stdout for both success and handled failures, but may
  // prefix it with plain-text lines (e.g. a CLI update warning) — parse from
  // the first "{".
  try {
    // Strip ANSI color codes — sf colorizes JSON when FORCE_COLOR is set
    // (Next's dev server sets it), even though we also pass NO_COLOR.
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const jsonStart = clean.indexOf("{");
    if (jsonStart < 0) throw new Error("no JSON in output");
    const parsed = JSON.parse(clean.slice(jsonStart));
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
