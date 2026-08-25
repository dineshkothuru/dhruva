import path from "node:path";
import { promises as fs } from "node:fs";

/** Folders never shown or served — build output and VCS/CLI internals. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".sfdx",
  ".sf",
  ".next",
  "dist",
  "out",
]);

export const MAX_FILE_BYTES = 1_500_000; // editor is for source files, not blobs

/** Resolve `rel` inside `root` and prove containment — the API must never
 * read or write outside the attached project folder. Returns the absolute
 * path or null when the input escapes the root (.., absolute paths, etc.). */
export function resolveInside(root: string, rel: string): string | null {
  if (typeof root !== "string" || typeof rel !== "string") return null;
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) return null;
  return abs;
}

/** The root itself must be a real directory that looks like an attached
 * project (has sfdx-project.json) — a second fence on top of containment. */
export async function isAttachableRoot(root: string): Promise<boolean> {
  if (!path.isAbsolute(root)) return false;
  try {
    const s = await fs.stat(path.join(path.resolve(root), "sfdx-project.json"));
    return s.isFile();
  } catch {
    return false;
  }
}
