import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { changesSince, takeSnapshot } from "@/lib/snapshot";

/** The harness must never report its own state directory as a project change.
 *
 * It did, twice. The first fix put ".dhruva" in the shadow repo's info/exclude,
 * which silences UNTRACKED files only - anything already in the index stays
 * tracked and keeps reporting forever. The second fix untracked those paths,
 * but only for exclude entries that had just been ADDED to the file, so once
 * ".dhruva" was present the untracking never ran again.
 *
 * A real project was then found with 2276 of the harness's own paths still
 * tracked. Every run reported .dhruva/shadow.git/index, logs/HEAD and
 * refs/heads/master as modified - the files any git command touches - and one
 * feature run showed eleven changed files of which five were the harness
 * watching itself work.
 *
 * These tests reproduce that legacy state directly: a path under .dhruva forced
 * into the index, exactly as an older harness version left it. */

const made: string[] = [];

/** These tests drive the real git binary, several invocations each. On Windows
 * under a loaded suite that runs well past vitest's 5s default. */
const SLOW = 30_000;

afterEach(async () => {
  for (const d of made.splice(0)) {
    // git may still hold a handle inside the shadow dir when the test ends,
    // and Windows reports EBUSY rather than waiting. Cleanup is best-effort:
    // a leftover temp dir is not a test failure.
    await fs.rm(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
      () => {},
    );
  }
});

function git(root: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const gitDir = path.join(root, ".dhruva", "shadow.git");
  return new Promise((resolve) => {
    execFile(
      "git",
      [`--git-dir=${gitDir}`, `--work-tree=${root}`, ...args],
      { cwd: root, timeout: 60_000, shell: false, windowsHide: true },
      (err, stdout) => resolve({ ok: !err, stdout: stdout ?? "" }),
    );
  });
}

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dhruva-shadow-"));
  made.push(root);
  // These tests reproduce LEGACY projects, whose shadow store lives inside
  // the project (fresh projects keep it outside, in the user's config dir).
  // Pre-creating the in-project git dir is what makes the harness pick the
  // legacy location - exactly the state an older version left behind.
  await fs.mkdir(path.join(root, ".dhruva", "shadow.git"), { recursive: true });
  await git(root, ["init", "-q"]);
  await fs.writeFile(
    path.join(root, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }),
    "utf8",
  );
  const src = path.join(root, "force-app", "main", "default", "classes");
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "Student.cls"), "public class Student {}", "utf8");
  return root;
}

/** Put .dhruva paths into the index the way an older harness left them: -f
 * overrides the exclude, which is exactly how those 2276 entries survived.
 *
 * Both kinds are tracked on purpose. A run json is inert and only proves the
 * index is polluted. The shadow repo's own log is the one that actually hurt:
 * git rewrites it on every command, so it reported as MODIFIED in every run -
 * the harness observing its own bookkeeping. A test that tracks only the inert
 * file passes without the fix, which is how the weaker version of this test
 * nearly shipped. */
async function trackStateDir(root: string): Promise<void> {
  const runs = path.join(root, ".dhruva", "runs");
  await fs.mkdir(runs, { recursive: true });
  await fs.writeFile(path.join(runs, "old-run.json"), '{"id":"old"}', "utf8");
  await git(root, ["add", "-f", ".dhruva/runs/old-run.json"]);
  await git(root, ["add", "-f", ".dhruva/shadow.git/logs/HEAD"]);
  await git(root, ["commit", "-q", "-m", "legacy: state dir tracked", "--allow-empty"]);
}

describe("the harness does not report itself as a change", () => {
  it("untracks state-dir paths an older version left in the index", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    await trackStateDir(root);

    // the legacy state: the harness's own file is in the index
    const before = await git(root, ["ls-files", "--", ".dhruva"]);
    expect(before.stdout.trim().length).toBeGreaterThan(0);

    // any snapshot operation reconciles it
    const changes = await changesSince(root);
    expect(changes).not.toBeNull();

    const after = await git(root, ["ls-files", "--", ".dhruva"]);
    expect(after.stdout.trim()).toBe("");
    expect(changes!.filter((c) => c.file.startsWith(".dhruva/"))).toEqual([]);
  }, SLOW);

  // Untracking alone would trade five noise rows for two thousand: HEAD still
  // holds the paths, so the next diff reports every one as DELETED. The removal
  // has to be committed in the same breath.
  it("commits the removal so nothing reports as deleted afterwards", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    await trackStateDir(root);

    await changesSince(root); // performs the reconcile
    const again = await changesSince(root);
    expect(again).not.toBeNull();
    expect(again!.some((c) => c.file.startsWith(".dhruva/"))).toBe(false);
    expect(again!.some((c) => c.status === "deleted")).toBe(false);
  }, SLOW);

  it("still reports real project changes", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    await trackStateDir(root);

    const cls = path.join(root, "force-app", "main", "default", "classes", "StudentTest.cls");
    await fs.writeFile(cls, "@isTest public class StudentTest {}", "utf8");

    const changes = await changesSince(root);
    const files = (changes ?? []).map((c) => c.file);
    expect(files).toContain("force-app/main/default/classes/StudentTest.cls");
    expect(files.filter((f) => f.startsWith(".dhruva/"))).toEqual([]);
  }, SLOW);

  it("leaves a clean project untouched and reports nothing", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    expect(await changesSince(root)).toEqual([]);
  }, SLOW);
});
