import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changesSince, headCommit, restoreFiles, takeSnapshot } from "@/lib/snapshot";

/** A run that dies after the implement step leaves half-finished edits in the
 * project. Undoing them by hand from a change list was the only way out, with
 * no record of what the files looked like before - even though the shadow store
 * had been holding exactly that state the whole time.
 *
 * Restoring has two halves that are easy to get wrong: a file the run EDITED
 * comes back from the snapshot, and a file the run CREATED has no snapshot
 * version, so putting it back means deleting it. */

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

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dhruva-restore-"));
  made.push(root);
  await fs.writeFile(
    path.join(root, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }),
    "utf8",
  );
  await fs.mkdir(path.join(root, ...CLASSES), { recursive: true });
  await fs.writeFile(path.join(root, ...CLASSES, "Existing.cls"), "ORIGINAL", "utf8");
  return root;
}

const rel = (name: string) => [...CLASSES, name].join("/");
const abs = (root: string, name: string) => path.join(root, ...CLASSES, name);

describe("undoing a failed run's file changes", () => {
  it("restores an edited file to its pre-run content", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    const base = await headCommit(root);
    expect(base).toBeTruthy();

    await fs.writeFile(abs(root, "Existing.cls"), "HALF FINISHED EDIT", "utf8");

    const res = await restoreFiles(root, base!, [rel("Existing.cls")]);
    expect(res.restored).toEqual([rel("Existing.cls")]);
    expect(res.failed).toEqual([]);
    expect(await fs.readFile(abs(root, "Existing.cls"), "utf8")).toBe("ORIGINAL");
  }, SLOW);

  // A created file has no snapshot version, so "putting it back" is deleting
  // it. Checking it out would fail and leave the run's file in place.
  it("deletes a file the run created", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    const base = await headCommit(root);

    await fs.writeFile(abs(root, "BrandNew.cls"), "made by the run", "utf8");

    const res = await restoreFiles(root, base!, [rel("BrandNew.cls")]);
    expect(res.removed).toEqual([rel("BrandNew.cls")]);
    expect(res.failed).toEqual([]);
    await expect(fs.access(abs(root, "BrandNew.cls"))).rejects.toBeTruthy();
  }, SLOW);

  it("handles both kinds in one restore, leaving nothing changed", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    const base = await headCommit(root);

    await fs.writeFile(abs(root, "Existing.cls"), "EDITED", "utf8");
    await fs.writeFile(abs(root, "BrandNew.cls"), "NEW", "utf8");

    const before = await changesSince(root);
    expect(before?.length).toBe(2);

    const res = await restoreFiles(root, base!, [rel("Existing.cls"), rel("BrandNew.cls")]);
    expect(res.restored).toEqual([rel("Existing.cls")]);
    expect(res.removed).toEqual([rel("BrandNew.cls")]);

    // the real proof: the project is back to reporting no changes at all
    expect(await changesSince(root)).toEqual([]);
  }, SLOW);

  // Only the paths given are touched. A restore must never become a sweep of
  // the working tree - the user may have their own edits in flight elsewhere.
  it("leaves files it was not asked about alone", async () => {
    const root = await project();
    await fs.writeFile(abs(root, "Other.cls"), "ORIGINAL OTHER", "utf8");
    expect(await takeSnapshot(root)).toBe(true);
    const base = await headCommit(root);

    await fs.writeFile(abs(root, "Existing.cls"), "EDITED", "utf8");
    await fs.writeFile(abs(root, "Other.cls"), "MY OWN WORK IN PROGRESS", "utf8");

    await restoreFiles(root, base!, [rel("Existing.cls")]);
    expect(await fs.readFile(abs(root, "Other.cls"), "utf8")).toBe("MY OWN WORK IN PROGRESS");
  }, SLOW);

  it("refuses a path that escapes the project", async () => {
    const root = await project();
    expect(await takeSnapshot(root)).toBe(true);
    const base = await headCommit(root);

    const res = await restoreFiles(root, base!, ["../outside.txt"]);
    expect(res.restored).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(res.failed[0].reason).toContain("escapes");
  }, SLOW);

  it("reports a bad commit instead of throwing", async () => {
    const root = await project();
    const res = await restoreFiles(root, "not-a-commit", [rel("Existing.cls")]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].reason).toContain("baseline");
  }, SLOW);
});
