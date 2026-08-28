import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";

/** Deterministic before/after snapshots of the attached project, independent
 * of whether the customer uses git: the harness keeps a PRIVATE shadow git
 * repo under <project>/.dhruva/shadow.git (git as a snapshot engine -
 * no remote, never pushed, invisible to the customer's own git because the
 * work-tree's .git dir is untouched and .dhruva is excluded). */

const SHADOW_DIRNAME = ".dhruva";

function shadowGitDir(root: string) {
  return path.join(root, SHADOW_DIRNAME, "shadow.git");
}

function runGit(root: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const fixed = [`--git-dir=${shadowGitDir(root)}`, `--work-tree=${root}`, ...args];
  return new Promise((resolve) => {
    execFile(
      "git",
      fixed,
      // Org retrieves can be 30k+ files: give add/commit real time.
      { cwd: root, timeout: 300_000, windowsHide: true, maxBuffer: 50_000_000 },
      (err, stdout) => resolve({ ok: !err, stdout: stdout ?? "" }),
    );
  });
}

/** A killed git process (timeout, crash) leaves index.lock behind and blocks
 * every later call. Single-user local tool: safe to clear a stale lock. */
async function clearStaleLock(root: string) {
  const lock = path.join(shadowGitDir(root), "index.lock");
  try {
    const s = await fs.stat(lock);
    // must exceed the git op timeout (300s) - a live add on a huge org tree
    // can legitimately hold the lock for minutes
    if (Date.now() - s.mtimeMs > 330_000) await fs.unlink(lock);
  } catch {
    /* no lock - fine */
  }
}

/** Never snapshot the shadow store itself, deps, or the customer's git. */
const EXCLUDES = [SHADOW_DIRNAME, ".git", "node_modules", ".sfdx", ".sf"];

/** Make sure every entry in EXCLUDES is in the shadow repo's exclude file, and
 * report the ones that had to be added.
 *
 * This runs on EVERY snapshot, not just at creation, because the list can
 * change under an existing project. It did: the state directory was renamed
 * .sfharness -> .dhruva, and repos created before that kept excluding the old
 * name. The harness then snapshotted its own run json and shadow git on every
 * step, and since the change list is capped, that noise crowded out the real
 * files completely - one measured run had 200 changed files, all of them
 * .dhruva bookkeeping and not one line of the Apex the run had just written.
 * Everything downstream reads that list: the reviewer, verify-standards, and
 * the deploy's file arguments. */
async function reconcileExclude(root: string): Promise<string[]> {
  const p = path.join(shadowGitDir(root), "info", "exclude");
  const cur = await fs.readFile(p, "utf8").catch(() => "");
  const lines = cur.split(/\r?\n/).map((l) => l.trim());
  const missing = EXCLUDES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return [];
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, [...lines.filter(Boolean), ...missing, ""].join("\n"), "utf8");
  return missing;
}

async function ensureShadow(root: string): Promise<boolean> {
  const gitDir = shadowGitDir(root);
  const exists = await fs
    .stat(path.join(gitDir, "HEAD"))
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await fs.mkdir(gitDir, { recursive: true });
    const init = await runGit(root, ["init", "-q"]);
    if (!init.ok) return false;
    await fs.writeFile(
      path.join(gitDir, "info", "exclude"),
      [...EXCLUDES, ""].join("\n"),
      "utf8",
    );
    await runGit(root, ["config", "user.email", "harness@local"]);
    await runGit(root, ["config", "user.name", "dhruva"]);
    // Salesforce org retrieves routinely exceed Windows' 260-char path limit
    // (e.g. nested report folders) - long paths must be on or add fails.
    await runGit(root, ["config", "core.longpaths", "true"]);
    // Snapshots must be byte-faithful; no line-ending rewriting or warnings.
    await runGit(root, ["config", "core.autocrlf", "false"]);
    await runGit(root, ["config", "core.safecrlf", "false"]);
  }
  // keep the customer's git (when present) blind to the shadow store
  const realGitInfo = path.join(root, ".git", "info");
  try {
    await fs.access(realGitInfo);
    const excludeFile = path.join(realGitInfo, "exclude");
    const cur = await fs.readFile(excludeFile, "utf8").catch(() => "");
    if (!cur.includes(SHADOW_DIRNAME)) {
      await fs.writeFile(excludeFile, `${cur.replace(/\n*$/, "\n")}${SHADOW_DIRNAME}\n`, "utf8");
    }
  } catch {
    /* no customer git - nothing to exclude */
  }
  // An exclude only silences UNTRACKED files. Anything already committed under
  // a newly excluded path keeps reporting as modified forever, so untrack it
  // once. --ignore-unmatch: most of these were never tracked.
  for (const e of await reconcileExclude(root)) {
    await runGit(root, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", e]);
  }
  return true;
}

/** Commit the current state as the "before" baseline. Returns false when git
 * is unavailable - callers degrade gracefully (no review, agent still runs). */
export async function takeSnapshot(root: string): Promise<boolean> {
  if (!(await ensureShadow(root))) return false;
  await clearStaleLock(root);
  await runGit(root, ["add", "-A"]);
  // --allow-empty keeps the baseline moving even when nothing changed
  const c = await runGit(root, ["commit", "-q", "--allow-empty", "-m", "baseline"]);
  return c.ok;
}

export interface ChangedFile {
  file: string;
  status: "modified" | "added" | "deleted";
}

/** Changes in the work tree since the last snapshot. */
export async function changesSince(root: string): Promise<ChangedFile[] | null> {
  if (!(await ensureShadow(root))) return null;
  // No baseline yet (first use): take one now - current state becomes the
  // reference, so "no changes" is the correct answer.
  const head = await runGit(root, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return (await takeSnapshot(root)) ? [] : null;
  }
  await clearStaleLock(root);
  await runGit(root, ["add", "-A", "-N"]); // track new files without staging content
  // --no-renames: a renamed file must surface as delete+add, or it would be
  // invisible to verify/review/deploy (the parser reads A/M/D lines only)
  const res = await runGit(root, ["diff", "--no-renames", "--name-status", "HEAD"]);
  if (!res.ok) return null;
  const out: ChangedFile[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^([AMD])\S*\t(.+)$/);
    if (!m) continue;
    out.push({
      file: m[2].replace(/\\/g, "/"),
      status: m[1] === "A" ? "added" : m[1] === "D" ? "deleted" : "modified",
    });
  }
  return out.slice(0, 200);
}

/** The snapshot ("before") content of one file; null when it didn't exist. */
export async function baselineContent(root: string, rel: string): Promise<string | null> {
  const res = await runGit(root, ["show", `HEAD:${rel.replace(/\\/g, "/")}`]);
  return res.ok ? res.stdout : null;
}

const COMMIT_RE = /^[0-9a-f]{7,40}$/;
export function isCommitHash(v: unknown): v is string {
  return typeof v === "string" && COMMIT_RE.test(v);
}

/** The current baseline commit hash (null before the first snapshot). */
export async function headCommit(root: string): Promise<string | null> {
  const r = await runGit(root, ["rev-parse", "HEAD"]);
  const h = r.stdout.trim().toLowerCase();
  return r.ok && COMMIT_RE.test(h) ? h : null;
}

/** Commit the current work-tree state WITHOUT moving HEAD (write-tree +
 * commit-tree) and pin it under refs/runs/<runId> so a later run's baseline
 * never erases this run's result - historical diffs stay reproducible. */
export async function commitRunResult(root: string, runId: string): Promise<string | null> {
  if (!/^[\w-]{1,64}$/.test(runId)) return null;
  if (!(await ensureShadow(root))) return null;
  await clearStaleLock(root);
  await runGit(root, ["add", "-A"]);
  const tree = await runGit(root, ["write-tree"]);
  if (!tree.ok) return null;
  const head = await headCommit(root);
  const args = ["commit-tree", tree.stdout.trim(), "-m", `run ${runId} result`];
  if (head) args.push("-p", head);
  const c = await runGit(root, args);
  const hash = c.stdout.trim().toLowerCase();
  if (!c.ok || !COMMIT_RE.test(hash)) return null;
  await runGit(root, ["update-ref", `refs/runs/${runId}`, hash]);
  return hash;
}

/** One file's content at a specific pinned commit; null when it didn't exist. */
export async function contentAt(root: string, commit: string, rel: string): Promise<string | null> {
  if (!COMMIT_RE.test(commit)) return null;
  const res = await runGit(root, ["show", `${commit}:${rel.replace(/\\/g, "/")}`]);
  return res.ok ? res.stdout : null;
}
