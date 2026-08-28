import path from "node:path";
import { resolveInside } from "@/lib/fsguard";
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
  await reconcileExclude(root);
  await reconcileIndex(root);
  return true;
}

/** Untrack anything the index still holds under an excluded path.
 *
 * An exclude only silences UNTRACKED files. A file already in the index stays
 * tracked, and `changesSince` diffs against HEAD, so it reports as changed on
 * every run forever.
 *
 * This used to run only for exclude entries that had just been ADDED to the
 * file, which made it a one-shot: once ".dhruva" was in info/exclude,
 * reconcileExclude returned nothing and the untracking never ran again. A real
 * project was found with 2276 of the harness's own paths still tracked, so
 * every run reported .dhruva/shadow.git/index, logs/HEAD and refs/heads/master
 * as modified - the five files any git command touches. One run showed eleven
 * changed files of which five were the harness watching itself work.
 *
 * So the check is now on the INDEX rather than on the exclude file, and it runs
 * on every ensure. It is cheap when there is nothing to do: one ls-files per
 * entry, and the rm only fires when that returns something.
 *
 * The removal is COMMITTED here rather than left staged. Untracking alone would
 * make things worse before better: HEAD still holds the paths, so the next
 * `diff HEAD` would report all 2276 as DELETED - trading five noise rows for
 * two thousand. Committing moves HEAD past them in the same breath, so the
 * repo is clean from the next diff onward whatever runs next. */
async function reconcileIndex(root: string): Promise<void> {
  let removed = false;
  for (const e of EXCLUDES) {
    const tracked = await runGit(root, ["ls-files", "--", e]);
    if (!tracked.ok || !tracked.stdout.trim()) continue;
    const rm = await runGit(root, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", e]);
    if (rm.ok) removed = true;
  }
  if (!removed) return;
  // A one-time migration per project, so the commit is worth its own message
  // in the shadow log rather than being folded into a baseline.
  await runGit(root, [
    "commit",
    "-q",
    "-m",
    "harness: untrack excluded paths",
    "--allow-empty",
  ]);
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

/** Changes in the work tree since a baseline.
 *
 * `since` is the commit the CALLER took as its baseline - a run passes its own,
 * so its change list cannot be emptied by someone else moving HEAD.
 *
 * The store is one repo with one HEAD, shared by every run on the project. Two
 * runs used to be enough to lose a run's work from its own list: run A
 * snapshots and starts editing, run B snapshots its baseline, HEAD moves
 * forward over everything A has written, and A's diff against HEAD reports
 * nothing. The reviewer, verify-standards and the deploy all read that list, so
 * an emptied list means a run reviews, verifies and deploys nothing while
 * reporting success.
 *
 * Pinning the baseline fixes the bookkeeping. It does NOT make concurrent runs
 * safe - one working tree means A's diff still contains B's files, whichever
 * commit it is measured against - which is why a second run on the same project
 * is refused outright. */
export async function changesSince(
  root: string,
  since?: string,
): Promise<ChangedFile[] | null> {
  if (!(await ensureShadow(root))) return null;
  // No baseline yet (first use): take one now - current state becomes the
  // reference, so "no changes" is the correct answer.
  const head = await runGit(root, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return (await takeSnapshot(root)) ? [] : null;
  }

  // A caller-supplied commit is only used once this repo confirms it has it:
  // a stale or foreign hash would otherwise turn the diff into "everything".
  let base = "HEAD";
  if (since && COMMIT_RE.test(since)) {
    const known = await runGit(root, ["cat-file", "-e", `${since}^{commit}`]);
    if (known.ok) base = since;
  }

  await clearStaleLock(root);
  await runGit(root, ["add", "-A", "-N"]); // track new files without staging content
  // --no-renames: a renamed file must surface as delete+add, or it would be
  // invisible to verify/review/deploy (the parser reads A/M/D lines only)
  const res = await runGit(root, ["diff", "--no-renames", "--name-status", base]);
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
export interface RestoreResult {
  restored: string[];
  removed: string[];
  failed: { file: string; reason: string }[];
}

/** Put the given files back the way they were at `commit`.
 *
 * For when a run fails or is aborted after it has already edited the project.
 * Until now the only way back was to undo an agent's work by hand, from a
 * change list, with no record of what the files looked like before - even though
 * the harness had been holding that exact state in the shadow store the whole
 * time.
 *
 * A file that did not exist at `commit` was created by the run, so restoring it
 * means deleting it. A file that did exist is checked out over the current one.
 * Each file is handled independently and failures are reported per file: a
 * partial restore with a list of what did not work beats an all-or-nothing
 * operation that leaves the caller guessing.
 *
 * This only touches the paths it is given, which are the run's own recorded
 * changes - never a sweep of the working tree. */
export async function restoreFiles(
  root: string,
  commit: string,
  files: string[],
): Promise<RestoreResult> {
  const out: RestoreResult = { restored: [], removed: [], failed: [] };
  if (!COMMIT_RE.test(commit)) {
    return { ...out, failed: files.map((f) => ({ file: f, reason: "no baseline commit" })) };
  }
  if (!(await ensureShadow(root))) {
    return { ...out, failed: files.map((f) => ({ file: f, reason: "snapshot store unavailable" })) };
  }
  await clearStaleLock(root);

  for (const raw of files) {
    const rel = raw.replace(/\\/g, "/");
    // Never step outside the project, whatever the recorded change list says.
    const abs = resolveInside(root, rel);
    if (!abs) {
      out.failed.push({ file: rel, reason: "path escapes the project" });
      continue;
    }

    const existed = await runGit(root, ["cat-file", "-e", `${commit}:${rel}`]);
    if (existed.ok) {
      const res = await runGit(root, ["checkout", commit, "--", rel]);
      if (res.ok) out.restored.push(rel);
      else out.failed.push({ file: rel, reason: "could not restore from the snapshot" });
      continue;
    }

    // Not in the baseline: the run created it, so removing it is the restore.
    try {
      await fs.rm(abs, { force: true });
      out.removed.push(rel);
    } catch (e) {
      out.failed.push({ file: rel, reason: String(e).slice(0, 200) });
    }
  }
  return out;
}

export async function contentAt(root: string, commit: string, rel: string): Promise<string | null> {
  if (!COMMIT_RE.test(commit)) return null;
  const res = await runGit(root, ["show", `${commit}:${rel.replace(/\\/g, "/")}`]);
  return res.ok ? res.stdout : null;
}
