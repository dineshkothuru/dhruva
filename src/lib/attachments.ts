import path from "node:path";
import { promises as fs } from "node:fs";

/** Where an uploaded file lives, and when it stops being temporary.
 *
 * Uploads used to land in one flat `.dhruva/attachments/` folder named by
 * upload time, and nothing ever removed them. One project accumulated thirteen
 * near-identical copies of the same BRD, which matters because an agent that
 * lists the folder instead of using the exact path is then choosing between
 * them at random - and one did try exactly that, saved only by `shell` being
 * denied to read-only steps.
 *
 * So the lifecycle is explicit:
 *
 *   .dhruva/tmp/attachments/<hash>-<name>     staged, before a run exists
 *   .dhruva/runs/<runId>/attachments/<name>   owned by the run that used it
 *
 * A file is staged at upload because chat has no run id yet. When a run starts
 * it MOVES the files it references into its own folder and rewrites the paths
 * recorded in its inputs, so the audit points at the copy that run actually
 * used. Anything still staged when the user closes the form without running is
 * deleted. Nothing is duplicated and nothing accumulates. */

const STAGE = path.join(".dhruva", "tmp", "attachments");

export function stageDir(root: string): string {
  return path.join(root, STAGE);
}

export function runAttachmentDir(root: string, runId: string): string {
  return path.join(root, ".dhruva", "runs", runId, "attachments");
}

/** Staged paths a requirement text points at, as project-relative posix paths.
 * Only our own staging folder is ever matched - never a caller-supplied path. */
export function stagedRefs(text: string): string[] {
  const re = /\.dhruva\/tmp\/attachments\/[A-Za-z0-9._-]+/g;
  return [...new Set((text.match(re) ?? []).map((p) => p.replace(/\\/g, "/")))];
}

/** Move every staged file a run references into that run's own folder and
 * return the rewritten text. A `.docx` moves together with its `.extracted.md`
 * sibling, because the requirement points at the extract while the original is
 * what a human opens.
 *
 * Best-effort by design: a file that cannot be moved keeps its staged path
 * rather than breaking the run, because a design that fails to start is worse
 * than one whose attachment is still in tmp. */
export async function adoptForRun(
  root: string,
  runId: string,
  text: string,
): Promise<{ text: string; moved: string[] }> {
  const refs = stagedRefs(text);
  if (refs.length === 0) return { text, moved: [] };
  const dest = runAttachmentDir(root, runId);
  await fs.mkdir(dest, { recursive: true }).catch(() => {});
  let out = text;
  const moved: string[] = [];

  for (const rel of refs) {
    const base = path.basename(rel);
    // the extract's sibling original, e.g. "<x>.docx" for "<x>.docx.extracted.md"
    const partners = base.endsWith(".extracted.md")
      ? [base, base.slice(0, -".extracted.md".length)]
      : [base, `${base}.extracted.md`];
    for (const name of partners) {
      const from = path.join(root, STAGE, name);
      const to = path.join(dest, name);
      try {
        await fs.rename(from, to);
        moved.push(name);
      } catch {
        // cross-device or already gone: copy, then drop the original
        try {
          await fs.copyFile(from, to);
          await fs.unlink(from).catch(() => {});
          moved.push(name);
        } catch {
          /* not present - the partner may simply not exist */
        }
      }
    }
    const stillThere = await fs
      .stat(path.join(dest, base))
      .then(() => true)
      .catch(() => false);
    if (stillThere) {
      out = out.replaceAll(rel, `.dhruva/runs/${runId}/attachments/${base}`);
    }
  }
  return { text: out, moved };
}

/** Delete named staged files - what the form calls when the user removes an
 * attachment, or closes without running. Confined to the staging folder: a
 * name with a separator or a traversal in it is refused, never resolved. */
export async function discardStaged(root: string, names: string[]): Promise<number> {
  let gone = 0;
  for (const raw of names) {
    const name = path.basename(raw);
    if (!name || name !== raw.replace(/\\/g, "/").split("/").pop() || name.includes("..")) continue;
    const abs = path.join(stageDir(root), name);
    for (const p of [abs, `${abs}.extracted.md`]) {
      if (await fs.unlink(p).then(() => true).catch(() => false)) gone++;
    }
  }
  return gone;
}
