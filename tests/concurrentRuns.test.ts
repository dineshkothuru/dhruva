import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changesSince, headCommit, takeSnapshot } from "@/lib/snapshot";

/** Two runs on one project share a single snapshot store, and that used to be
 * enough to lose a run's work from its own change list.
 *
 * The store is one git repo with one HEAD. Run A snapshots a baseline and starts
 * editing; run B then snapshots ITS baseline, which moves HEAD forward over
 * everything A has written so far. A's change step diffs against HEAD, so A's
 * own files are already "in the baseline" and report as unchanged.
 *
 * That list is not cosmetic - the reviewer, verify-standards and the deploy all
 * read it. A silently emptied change list means a run reviews nothing, verifies
 * nothing, and deploys nothing while reporting success.
 *
 * The fix is for each run to diff against the baseline IT took, identified by
 * its own commit, rather than against whatever HEAD happens to be now. */

const made: string[] = [];
const SLOW = 30_000;

afterEach(async () => {
  for (const d of made.splice(0)) {
    await fs.rm(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
      () => {},
    );
  }
});

const CLASSES = ["force-app", "main", "default", "classes"];
const rel = (n: string) => [...CLASSES, n].join("/");

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dhruva-concurrent-"));
  made.push(root);
  await fs.writeFile(
    path.join(root, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }),
    "utf8",
  );
  await fs.mkdir(path.join(root, ...CLASSES), { recursive: true });
  return root;
}

function write(root: string, name: string, body: string): Promise<void> {
  return fs.writeFile(path.join(root, ...CLASSES, name), body, "utf8");
}

describe("a run's change list survives another run snapshotting", () => {
  it("still sees its own work after a second baseline moves HEAD", async () => {
    const root = await project();

    // run A takes its baseline and does some work
    expect(await takeSnapshot(root)).toBe(true);
    const runABase = await headCommit(root);
    expect(runABase).toBeTruthy();
    await write(root, "RunAWork.cls", "public class RunAWork {}");

    // run B starts and snapshots - HEAD now includes RunAWork.cls
    expect(await takeSnapshot(root)).toBe(true);
    expect(await headCommit(root)).not.toBe(runABase);

    // Against HEAD, A's work has vanished into the baseline.
    expect(await changesSince(root)).toEqual([]);

    // Against A's OWN baseline, it is still there. This is the whole fix.
    const seen = await changesSince(root, runABase!);
    expect(seen?.map((c) => c.file)).toContain(rel("RunAWork.cls"));
  }, SLOW);

  it("attributes each run's files to the baseline that run took", async () => {
    const root = await project();

    expect(await takeSnapshot(root)).toBe(true);
    const runABase = await headCommit(root);
    await write(root, "FromA.cls", "A");

    expect(await takeSnapshot(root)).toBe(true);
    const runBBase = await headCommit(root);
    await write(root, "FromB.cls", "B");

    const aSees = (await changesSince(root, runABase!))?.map((c) => c.file) ?? [];
    const bSees = (await changesSince(root, runBBase!))?.map((c) => c.file) ?? [];

    // A took its baseline first, so it sees both files: they share one working
    // tree, and no commit can separate work done in the same folder. This is
    // exactly why concurrent runs on one project are refused rather than
    // merely accounted for - the per-run baseline fixes the bookkeeping, not
    // the interference.
    expect(aSees).toContain(rel("FromA.cls"));
    expect(aSees).toContain(rel("FromB.cls"));

    // B's baseline was taken after A's file existed, so B sees only its own.
    expect(bSees).toEqual([rel("FromB.cls")]);
  }, SLOW);

  it("defaults to HEAD when no baseline is given", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    await write(root, "New.cls", "x");
    const seen = await changesSince(root);
    expect(seen?.map((c) => c.file)).toEqual([rel("New.cls")]);
  }, SLOW);

  // A hash from a different repo, or a truncated one, must not silently become
  // "diff against everything".
  it("falls back to HEAD rather than trusting an unusable commit", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    await write(root, "New.cls", "x");
    const seen = await changesSince(root, "not-a-commit");
    expect(seen?.map((c) => c.file)).toEqual([rel("New.cls")]);
  }, SLOW);
});
