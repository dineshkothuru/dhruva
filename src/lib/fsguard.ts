import path from "node:path";
import { promises as fs } from "node:fs";

/** Folders never shown or served - build output and VCS/CLI internals. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".sfdx",
  ".sf",
  ".sfharness", // legacy name - auto-migrated to .dhruva on attach
  ".dhruva",
  ".next",
  "dist",
  "out",
]);

export const MAX_FILE_BYTES = 1_500_000; // editor is for source files, not blobs

/** Resolve `rel` inside `root` and prove containment - the API must never
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
 * project (has sfdx-project.json) - a second fence on top of containment. */
export async function isAttachableRoot(root: string): Promise<boolean> {
  if (!path.isAbsolute(root)) return false;
  try {
    const s = await fs.stat(path.join(path.resolve(root), "sfdx-project.json"));
    if (!s.isFile()) return false;
    await migrateHarnessDir(path.resolve(root));
    return true;
  } catch {
    return false;
  }
}

/** One-time rename of the legacy state folder: projects attached before the
 * Dhruva rename keep their run history, snapshots, skills, and settings.
 * Every API entry passes through isAttachableRoot, so this runs before any
 * read or write path touches the folder. Concurrent calls are safe - the
 * loser's rename fails on ENOENT and is ignored. */
async function migrateHarnessDir(absRoot: string): Promise<void> {
  const legacy = path.join(absRoot, ".sfharness");
  const current = path.join(absRoot, ".dhruva");
  try {
    const [hasLegacy, hasCurrent] = await Promise.all([
      fs.stat(legacy).then((x) => x.isDirectory()).catch(() => false),
      fs.stat(current).then(() => true).catch(() => false),
    ]);
    if (hasLegacy && !hasCurrent) await fs.rename(legacy, current);
  } catch {
    /* best-effort - a locked folder just stays legacy until the next call */
  }
}
