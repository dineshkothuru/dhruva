import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAttachableRoot, resolveInside } from "@/lib/fsguard";

/** fsguard is the security fence: every API route resolves user-supplied
 * paths through it. A hole here means an attached "project" could read or
 * write anywhere on the machine. */
describe("resolveInside", () => {
  const root = path.resolve("/projects/app");

  it("resolves a normal relative path", () => {
    expect(resolveInside(root, "src/index.ts")).toBe(path.join(root, "src/index.ts"));
  });

  it("allows the root itself", () => {
    expect(resolveInside(root, ".")).toBe(root);
  });

  it("blocks traversal with ..", () => {
    expect(resolveInside(root, "../secrets.txt")).toBeNull();
  });

  it("blocks nested traversal that climbs out", () => {
    expect(resolveInside(root, "src/../../secrets.txt")).toBeNull();
  });

  it("blocks an absolute path", () => {
    expect(resolveInside(root, path.resolve("/etc/passwd"))).toBeNull();
  });

  it("blocks a sibling directory with a shared prefix", () => {
    expect(resolveInside(root, "../app-evil/file.ts")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(resolveInside(root, undefined as unknown as string)).toBeNull();
  });
});

describe("isAttachableRoot", () => {
  const made: string[] = [];
  const tmp = async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "dhruva-guard-"));
    made.push(d);
    return d;
  };
  afterEach(async () => {
    while (made.length) await fs.rm(made.pop()!, { recursive: true, force: true });
  });

  it("rejects a relative path", async () => {
    expect(await isAttachableRoot("./somewhere")).toBe(false);
  });

  it("rejects a folder without sfdx-project.json", async () => {
    expect(await isAttachableRoot(await tmp())).toBe(false);
  });

  it("accepts a real SFDX project", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "sfdx-project.json"), "{}");
    expect(await isAttachableRoot(d)).toBe(true);
  });

  it("migrates a legacy .sfharness folder to .dhruva, preserving contents", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "sfdx-project.json"), "{}");
    await fs.mkdir(path.join(d, ".sfharness", "runs"), { recursive: true });
    await fs.writeFile(path.join(d, ".sfharness", "runs", "r1.json"), '{"runId":"r1"}');

    expect(await isAttachableRoot(d)).toBe(true);

    const carried = await fs.readFile(path.join(d, ".dhruva", "runs", "r1.json"), "utf8");
    expect(carried).toContain("r1");
    await expect(fs.stat(path.join(d, ".sfharness"))).rejects.toThrow();
  });

  it("is idempotent and never overwrites an existing .dhruva", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "sfdx-project.json"), "{}");
    await fs.mkdir(path.join(d, ".dhruva"), { recursive: true });
    await fs.writeFile(path.join(d, ".dhruva", "keep.json"), "current");
    await fs.mkdir(path.join(d, ".sfharness"), { recursive: true });
    await fs.writeFile(path.join(d, ".sfharness", "old.json"), "legacy");

    expect(await isAttachableRoot(d)).toBe(true);
    expect(await isAttachableRoot(d)).toBe(true);

    expect(await fs.readFile(path.join(d, ".dhruva", "keep.json"), "utf8")).toBe("current");
    expect(await fs.readFile(path.join(d, ".sfharness", "old.json"), "utf8")).toBe("legacy");
  });
});
