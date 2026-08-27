import { promises as fs } from "node:fs";
import path from "node:path";
import type { DetectionResult, PackageDir } from "./types";
import { sfOrgDisplay } from "./sfcli";

/** Validate a folder as a Salesforce (SFDX) project and gather its context.
 * Read-only: parses sfdx-project.json and probes the sf CLI; never executes
 * anything found inside the target folder. */
export async function detectProject(
  rawPath: string,
  opts?: { skipOrg?: boolean },
): Promise<DetectionResult> {
  const p = path.normalize(rawPath.trim());

  let stat;
  try {
    stat = await fs.stat(p);
  } catch {
    return { status: "not_found", path: p, message: "Folder not found" };
  }
  if (!stat.isDirectory()) {
    return { status: "not_found", path: p, message: "Path is not a folder" };
  }

  let raw: string;
  try {
    raw = await fs.readFile(path.join(p, "sfdx-project.json"), "utf8");
  } catch {
    const entries = await fs.readdir(p).catch(() => null);
    const isEmptyFolder = entries !== null && entries.length === 0;
    return {
      status: "not_salesforce",
      path: p,
      isEmptyFolder,
      message: isEmptyFolder
        ? "Empty folder - you can scaffold a new Salesforce project here."
        : "No sfdx-project.json found at the folder root - this is not a Salesforce DX project.",
    };
  }

  let project: {
    name?: string;
    sourceApiVersion?: string;
    packageDirectories?: { path?: string; default?: boolean }[];
  };
  try {
    project = JSON.parse(raw);
  } catch {
    return {
      status: "not_salesforce",
      path: p,
      message: "sfdx-project.json exists but is not valid JSON.",
    };
  }

  const packageDirectories: PackageDir[] = (project.packageDirectories ?? [])
    .filter((d) => typeof d.path === "string")
    .map((d) => ({ path: d.path as string, default: d.default === true }));

  const isGitRepo = await fs
    .stat(path.join(p, ".git"))
    .then((s) => s.isDirectory())
    .catch(() => false);

  // The sf CLI probe takes seconds - callers can skip it to render the
  // repo-level result instantly and fetch the org badge separately.
  const org = opts?.skipOrg
    ? { connected: false, reason: "checking…" }
    : await sfOrgDisplay(p);

  return {
    status: "connected",
    path: p,
    projectName: project.name,
    sourceApiVersion: project.sourceApiVersion,
    packageDirectories,
    isGitRepo,
    org,
  };
}
