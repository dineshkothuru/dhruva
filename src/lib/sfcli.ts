import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { getOrgConnection } from "@/lib/org/connection";

export interface OrgStatus {
  connected: boolean;
  username?: string;
  instanceUrl?: string;
  reason?: string;
}

/** Who this project is connected to, for the org badge.
 *
 * This used to be two `sf` calls - `sf config get target-org` then `sf org
 * display` - which measured 21 seconds on attach. Almost none of that was work:
 * `sf --version` alone is ~6s of process boot, and this paid it twice.
 *
 * So the CONNECTED case is answered in-process now. The CLI path is kept
 * verbatim below for everything else, because it produces messages this cannot:
 * it can tell "sf is not installed" apart from "no org here", and it can name
 * the machine-wide default org that is being deliberately ignored. Those only
 * matter when something is wrong, and when something is wrong nobody minds
 * waiting. */
export async function sfOrgDisplay(cwd: string): Promise<OrgStatus> {
  // Only a PROJECT-LOCAL target-org counts. Reading .sf/config.json directly is
  // exactly what the `location === "Local"` check below enforces - a project's
  // own config file, never the machine-wide default, which would show an org
  // the user never authorised for this project.
  const local = await projectLocalTargetOrg(cwd);
  if (local) {
    const got = await getOrgConnection(cwd);
    if (got.ok) {
      return {
        connected: true,
        username: got.org.username,
        instanceUrl: got.org.conn.instanceUrl ?? undefined,
      };
    }
  }

  return sfOrgDisplayViaCli(cwd);
}

/** The project's own target-org, or null. */
async function projectLocalTargetOrg(cwd: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(cwd, ".sf", "config.json"), "utf8");
    const v = JSON.parse(raw)?.["target-org"];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** The original CLI implementation, unchanged. Slow, but it is the only thing
 * that can distinguish the failure modes precisely. */
async function sfOrgDisplayViaCli(cwd: string): Promise<OrgStatus> {
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
 * FORCE_COLOR is set - Next's dev server sets it) and skip any plain-text
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
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          // shell:true resolves the bare command via cmd.exe, which searches the
          // CURRENT DIRECTORY first on Windows - and cwd is the attached (untrusted)
          // project, so a planted sf.cmd would run. This flag removes cwd from that
          // search; the real CLI on PATH still resolves.
          NoDefaultCurrentDirectoryInExePath: "1",
        },
      },
      (err, stdout) => {
        resolve({ stdout: stdout ?? "", error: err ? String(err.message) : undefined });
      },
    );
  });
}
