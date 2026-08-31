import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSfJson, runSf } from "@/lib/orgMetadata";
import { getOrgConnection } from "@/lib/org/connection";
import { rowsToFiles, soqlFor, toolingTargetFor } from "@/lib/org/toolingSource";

/** Compare ONE local source file against the org's copy of it, without
 * touching the working tree.
 *
 * The obvious implementation - `sf project retrieve start --source-dir <file>`
 * - is the one thing this must never do: that overwrites the file being
 * compared, so by the time you can look at the org's version, the local
 * version you wanted to compare it to is gone. That command already exists in
 * the app as "Retrieve from org" and it is a deliberate, destructive action.
 * Compare has to be read-only on both sides.
 *
 * So the retrieve happens inside a THROWAWAY SANDBOX PROJECT in the OS temp
 * directory: a minimal sfdx-project.json, the project's own target-org config,
 * and a copy of just the component being compared. sf resolves the component
 * from the copied files exactly as it would in the real project, retrieves the
 * org's version on top of the copy, and the real working tree is never an
 * argument to anything.
 *
 * The sandbox is OUTSIDE the attached project, and carries its own empty
 * .forceignore, for one measured reason. sf looks for .forceignore by walking
 * UP from the source path, so a sandbox under <project>/.dhruva/tmp finds the
 * CUSTOMER's .forceignore and evaluates its patterns against the sandbox - and
 * the result is a retrieve that resolves zero components and reports
 * `{"files": []}` with exit code 0. Not an error, just silence, which is the
 * worst possible failure. Either fix alone works; both are kept because the
 * cost is two lines and the symptom is unreadable.
 *
 * The empty .forceignore is also correct on its own terms: a path the customer
 * force-ignores is exactly the path someone needs a compare for, so the
 * compare must not inherit ignore rules from anywhere.
 *
 * Two other approaches were tried first and are recorded here so they are not
 * re-attempted:
 *
 *  - `--source-dir <file> --output-dir <tmp>`: sf refuses the combination
 *    outright ("--source-dir cannot also be provided when using
 *    --output-dir").
 *  - `--metadata <Type>:<Name> --output-dir <tmp>`: works, but requires this
 *    code to map a source path to a metadata type and member name for every
 *    type Salesforce ships - a table that is wrong the moment a release adds a
 *    type, and wrong in a way that reports "not in the org" rather than
 *    erroring. The sandbox lets sf do that resolution, which is sf's job.
 *
 * The only shell argument is the literal "pkg" - the sandbox's package
 * directory. No customer path, component name or org name reaches a command
 * line, which matters because runSf goes through a shell on Windows and real
 * component names contain spaces, dollars and percent-escapes. */

/** Distinguishes two sandboxes created in the same millisecond. */
let seq = 0;

/** Cached org-side content, because a compare costs ~15s and about 9s of that
 * is the `sf` process starting up - measured: `sf --version` alone is 6s on a
 * loaded machine, `sf config get target-org` 8.9s, the full retrieve 12.9s. So
 * only about a third of the wait is the org; the rest is overhead that cannot
 * be optimised away while the CLI is the transport.
 *
 * Two things make the cache pay far more than a naive "remember the last
 * answer" would:
 *
 *  1. A retrieve fetches the WHOLE component, not the one file being compared.
 *     An LWC bundle comes back as .html + .js + .js-meta.xml. Harvesting all of
 *     them into the cache makes comparing the second and third file of a bundle
 *     free, which is exactly what someone does when a component looks wrong.
 *  2. The Re-fetch button bypasses it, so "is this still current?" always has a
 *     definite answer rather than a guess about staleness.
 *
 * Held on globalThis so a dev-mode module reload does not throw it away. */
interface CacheEntry {
  org: string | null;
  type?: string;
  at: number;
}
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 300;
const cacheStore = globalThis as unknown as { __dhruvaOrgCache?: Map<string, CacheEntry> };
const orgCache: Map<string, CacheEntry> = (cacheStore.__dhruvaOrgCache ??= new Map());

/** NUL, not a space or a colon: a Windows path contains colons and may contain
 * spaces, so either could let two different keys collide. Same reasoning as the
 * Org Browser's listing key. */
const KEY_SEP = String.fromCharCode(0);

function cacheKey(root: string, rel: string) {
  return root + KEY_SEP + rel;
}

function cacheGet(root: string, rel: string): CacheEntry | null {
  const hit = orgCache.get(cacheKey(root, rel));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    orgCache.delete(cacheKey(root, rel));
    return null;
  }
  return hit;
}

function cachePut(root: string, rel: string, entry: CacheEntry) {
  if (orgCache.size >= CACHE_MAX) {
    // Oldest-first eviction; the map preserves insertion order.
    const oldest = orgCache.keys().next();
    if (!oldest.done) orgCache.delete(oldest.value);
  }
  orgCache.set(cacheKey(root, rel), entry);
}

/** Drop everything cached for a project - used when the user asks for a fresh
 * answer, so Re-fetch is never satisfied from memory. */
export function invalidateOrgCache(root: string) {
  for (const k of [...orgCache.keys()]) {
    if (k.startsWith(root + KEY_SEP)) orgCache.delete(k);
  }
}

/** Type folders whose members are DIRECTORIES, not files.
 *
 * For these the component is the folder, so copying just the one file into the
 * sandbox leaves sf nothing it can resolve - an LWC without its .js-meta.xml
 * is not a component. A table rather than a heuristic because the set is
 * finite and known, and because guessing wrong here fails as "not in the org"
 * instead of as an error. A type missing from the table still works, it just
 * falls back to the file-and-siblings rule below. */
const BUNDLE_DIRS = new Set([
  "aura",
  "lwc",
  "waveTemplates",
  "experiences",
  "digitalExperiences",
  "staticresources",
  "objects",
  "objectTranslations",
  "moderation",
  // folder-based types: the member sits inside its Salesforce folder
  "reports",
  "dashboards",
  "documents",
  "email",
]);

/** Sandbox copies stay small on purpose: an object folder on a real org can
 * hold thousands of field files, and the compare is supposed to feel instant. */
const MAX_COPY_FILES = 800;
const MAX_COPY_BYTES = 25_000_000;

/** The project's package directories, as forward-slash relative paths.
 *
 * Read from sfdx-project.json rather than assumed, because "force-app" is a
 * convention and brownfield projects routinely have several package dirs with
 * other names. */
export async function packageDirs(root: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(root, "sfdx-project.json"), "utf8");
    const dirs = JSON.parse(raw)?.packageDirectories;
    if (Array.isArray(dirs)) {
      const out = dirs
        .map((d: unknown) =>
          d && typeof d === "object" && typeof (d as { path?: unknown }).path === "string"
            ? String((d as { path: string }).path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
            : "",
        )
        .filter((p: string) => p.length > 0);
      if (out.length > 0) return out;
    }
  } catch {
    /* unreadable or malformed - the convention is the best remaining answer */
  }
  return ["force-app"];
}

/** Split a project-relative path into its package directory and the rest.
 * Null means the file is not inside any package directory, so it is not
 * metadata and there is nothing in the org to compare it to. */
export function splitPackagePath(
  rel: string,
  pkgDirs: string[],
): { pkg: string; rest: string } | null {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  // Longest match first: a project with "force-app" and "force-app/extra"
  // must attribute a file to the more specific one.
  for (const pkg of [...pkgDirs].sort((a, b) => b.length - a.length)) {
    if (norm.startsWith(pkg + "/")) {
      const rest = norm.slice(pkg.length + 1);
      if (rest.length > 0) return { pkg, rest };
    }
  }
  return null;
}

/** What has to be copied into the sandbox for sf to resolve the component.
 *
 * `dir` = copy this whole folder (a bundle, an object, a report folder).
 * `file` = copy this file plus its same-stem siblings, which is how a class
 * and its .cls-meta.xml, or a static resource and its .resource-meta.xml,
 * stay together. */
export function copyPlanFor(rest: string): { kind: "dir" | "file"; target: string } {
  const segs = rest.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    if (!BUNDLE_DIRS.has(segs[i])) continue;
    // The member has to be a DIRECTORY for this to be a bundle: there must be
    // at least one segment after it. `staticresources/foo.resource-meta.xml`
    // is a plain file even though staticresources can also hold folders.
    if (i + 2 <= segs.length - 1) {
      return { kind: "dir", target: segs.slice(0, i + 2).join("/") };
    }
    break;
  }
  return { kind: "file", target: rest };
}

/** The stem a file shares with its metadata companion: everything before the
 * first dot. "Foo.cls" and "Foo.cls-meta.xml" share "Foo"; "FooBar.cls" does
 * not, so it is not dragged along. */
export function sameStemPrefix(fileName: string): string {
  const dot = fileName.indexOf(".");
  return (dot < 0 ? fileName : fileName.slice(0, dot)) + ".";
}

export interface OrgFileState {
  /** Every file sf reported, keyed by absolute path, with its state. */
  ok: boolean;
  /** true when the org has no such component - a locally-new file. */
  missing: boolean;
  /** sf's own words, for anything that is neither success nor missing. */
  error?: string;
}

/** Read sf's retrieve result rather than guessing from the files on disk.
 *
 * This matters more than it looks. The sandbox starts as a COPY of the local
 * file, so a component the org does not have leaves that copy untouched and
 * the two sides come out byte-identical - which would render as "no
 * differences" when the truth is "this file does not exist in the org at all".
 * sf says so explicitly (state "Failed", "Entity of type ... cannot be
 * found"), and that is the only trustworthy signal. */
export function readRetrieveOutcome(stdout: string, sfOk: boolean): OrgFileState {
  const parsed = parseSfJson(stdout);
  const result = parsed?.result ?? parsed;
  const files: unknown = result?.files;

  // An EMPTY files array is sf saying "I resolved no component from that
  // path" - exit code 0, no message, nothing retrieved. It has to be named,
  // because the generic wording sent a real debugging session down the wrong
  // path: the cause was an inherited .forceignore, not a missing component.
  if (Array.isArray(files) && files.length === 0) {
    return {
      ok: false,
      missing: false,
      error:
        "sf resolved no metadata component from this file - it may not be a deployable source file, or an ignore rule is filtering it out",
    };
  }

  if (Array.isArray(files) && files.length > 0) {
    const entries = files as { state?: unknown; error?: unknown; problemType?: unknown }[];
    const failed = entries.filter((f) => f.state === "Failed");
    if (failed.length === entries.length) {
      const msg = failed.map((f) => String(f.error ?? "")).find((m) => m.length > 0) ?? "";
      // "cannot be found" is the org saying the component does not exist,
      // which is an ANSWER, not a failure. Anything else is a real error.
      if (/cannot be found|not found|Cannot find/i.test(msg)) {
        return { ok: true, missing: true };
      }
      return { ok: false, missing: false, error: msg || "retrieve failed" };
    }
    return { ok: true, missing: false };
  }

  const msg =
    (typeof result?.message === "string" && result.message) ||
    (typeof parsed?.message === "string" && parsed.message) ||
    (typeof parsed?.name === "string" && parsed.name) ||
    "";
  if (/cannot be found|not found|No metadata/i.test(msg)) {
    return { ok: true, missing: true };
  }
  if (!sfOk || msg) {
    return { ok: false, missing: false, error: msg || "sf returned no retrieve result" };
  }
  return { ok: false, missing: false, error: "sf returned no retrieve result" };
}

/** Cache every file the retrieve brought back, keyed by its project-relative
 * path.
 *
 * The sandbox mirrors the project layout under `pkg/`, so a file at
 * `pkg/main/default/lwc/x/x.js` corresponds to `<pkgDir>/main/default/lwc/x/x.js`
 * in the real project - which is exactly the key a later compare of that file
 * will look up. */
async function harvestSandbox(
  sandbox: string,
  root: string,
  pkgDir: string,
  at: number,
  type?: string,
): Promise<void> {
  const pkgRoot = path.join(sandbox, "pkg");
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const relInPkg = path.relative(pkgRoot, abs).split(path.sep).join("/");
      const content = await fs.readFile(abs, "utf8").catch(() => null);
      if (content === null) continue;
      cachePut(root, `${pkgDir}/${relInPkg}`, { org: content, type, at });
    }
  };
  await walk(pkgRoot).catch(() => {});
}

/** Recursive copy with hard caps, so a pathological component (an object
 * folder with thousands of fields) cannot stall the compare. */
async function copyTree(
  src: string,
  dest: string,
  budget: { files: number; bytes: number },
): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dest, { recursive: true });
  for (const e of entries) {
    if (budget.files <= 0 || budget.bytes <= 0) return;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyTree(from, to, budget);
    } else if (e.isFile()) {
      const st = await fs.stat(from).catch(() => null);
      if (!st) continue;
      budget.files -= 1;
      budget.bytes -= st.size;
      await fs.copyFile(from, to);
    }
  }
}

export interface CompareResult {
  /** The org's version of the file; null when the org has no such component. */
  org: string | null;
  /** The local version; null when the file is not on disk. */
  local: string | null;
  /** Set when the compare could not be completed - sf's own words. */
  error?: string;
  /** The metadata type sf resolved, for the header ("ApexClass"). */
  type?: string;
  /** When the org side was actually fetched. Equal to now for a fresh
   * retrieve; older when it came from the cache, which the UI shows so a
   * cached answer is never mistaken for a live one. */
  fetchedAt?: number;
  /** True when the org side came from memory rather than the org. */
  cached?: boolean;
}

/** One Tooling API query for the whole component, or null to fall back.
 *
 * Never throws and never reports an error: every failure here - no org, an
 * expired token, a type the table does not cover, a component that only exists
 * locally - is answered by returning null so the caller uses the retrieve path.
 * A fast path that can break the slow path is not worth having. */
async function tryToolingFetch(
  root: string,
  rel: string,
  pkgDir: string,
  rest: string,
): Promise<{ org: string | null; type?: string; fetchedAt: number } | null> {
  const target = toolingTargetFor(rest);
  if (!target) return null;
  const soql = soqlFor(target);
  if (!soql) return null;

  const got = await getOrgConnection(root);
  if (!got.ok) return null;

  try {
    const res = await got.org.conn.tooling.query(soql);
    const rows: Record<string, unknown>[] = Array.isArray(res?.records) ? res.records : [];
    const now = Date.now();

    // No rows means the org does not have this component. That is an ANSWER -
    // the file is local-only - and caching it saves paying again to learn the
    // same thing.
    if (rows.length === 0) {
      cachePut(root, rel, { org: null, type: target.object, at: now });
      return { org: null, type: target.object, fetchedAt: now };
    }

    const files = rowsToFiles(target, pkgDir, rows);
    // The query fetched the WHOLE component, so cache all of it: the second
    // file of an LWC bundle then costs nothing at all.
    for (const [p, content] of files) {
      cachePut(root, p, { org: content, type: target.object, at: now });
    }

    const mine = files.get(rel);
    if (mine === undefined) {
      // The component exists but this particular file does not - an LWC whose
      // org version has no .css, for instance.
      cachePut(root, rel, { org: null, type: target.object, at: now });
      return { org: null, type: target.object, fetchedAt: now };
    }
    return { org: mine, type: target.object, fetchedAt: now };
  } catch {
    return null;
  }
}

/** Retrieve the org's copy of one file into a sandbox and return both sides.
 * Never writes anywhere except <root>/.dhruva/tmp, which the snapshot store
 * already excludes. */
export async function compareFileWithOrg(
  root: string,
  rel: string,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<CompareResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pkgDirs = await packageDirs(root);
  const split = splitPackagePath(rel, pkgDirs);
  if (!split) {
    return {
      org: null,
      local: null,
      error: `not inside a package directory (${pkgDirs.join(", ")}) - only metadata can be compared with the org`,
    };
  }

  const local = await fs.readFile(path.join(root, rel), "utf8").catch(() => null);

  // The local side is always read fresh - it is a file read, it costs nothing,
  // and showing a stale copy of the user's own file would be indefensible.
  // Only the ORG side is ever cached.
  if (!opts.force) {
    const hit = cacheGet(root, rel);
    if (hit) {
      return { org: hit.org, local, type: hit.type, fetchedAt: hit.at, cached: true };
    }
  } else {
    invalidateOrgCache(root);
  }

  // FAST PATH. Apex, LWC and Aura keep their source in Tooling API objects, so
  // one SOQL replaces a whole Metadata API retrieve: 0.3-0.4s against ~15s,
  // because it also skips the `sf` process boot that was two thirds of the
  // wait. Anything this does not cover - layouts, objects, flexipages, and the
  // -meta.xml companions - falls through to the retrieve below, which is why an
  // incomplete fast path is safe.
  const fast = await tryToolingFetch(root, rel, split.pkg, split.rest);
  if (fast) return { ...fast, local };

  const sandbox = path.join(os.tmpdir(), "dhruva-compare", `${process.pid}-${seq++}`);
  const pkgRoot = path.join(sandbox, "pkg");
  try {
    await fs.mkdir(path.join(sandbox, ".sf"), { recursive: true });
    // Stops sf's upward .forceignore search dead - see the note at the top of
    // this file. Without it a compare silently finds nothing.
    await fs.writeFile(path.join(sandbox, ".forceignore"), "", "utf8");

    // A MINIMAL project rather than a copy of the customer's: one package
    // directory with a fixed, shell-safe name, so "pkg" is the only path that
    // ever reaches the command line. The api version is carried over because
    // retrieving at a different version can return different XML and would
    // show as a spurious diff.
    const real = await fs
      .readFile(path.join(root, "sfdx-project.json"), "utf8")
      .then((r) => JSON.parse(r))
      .catch(() => ({}) as Record<string, unknown>);
    await fs.writeFile(
      path.join(sandbox, "sfdx-project.json"),
      JSON.stringify(
        {
          packageDirectories: [{ path: "pkg", default: true }],
          namespace: typeof real?.namespace === "string" ? real.namespace : "",
          sourceApiVersion:
            typeof real?.sourceApiVersion === "string" ? real.sourceApiVersion : undefined,
          sfdcLoginUrl: typeof real?.sfdcLoginUrl === "string" ? real.sfdcLoginUrl : undefined,
          name: "dhruva-compare",
        },
        null,
        2,
      ),
      "utf8",
    );

    // The org this project is attached to. Auth itself lives in the user's
    // home directory; only the target-org choice is project-local, and
    // without it the sandbox would fall back to the machine-wide default -
    // a different org than the one the user is looking at.
    const cfg = await fs.readFile(path.join(root, ".sf", "config.json"), "utf8").catch(() => null);
    if (cfg) await fs.writeFile(path.join(sandbox, ".sf", "config.json"), cfg, "utf8");

    const plan = copyPlanFor(split.rest);
    const budget = { files: MAX_COPY_FILES, bytes: MAX_COPY_BYTES };
    if (plan.kind === "dir") {
      await copyTree(
        path.join(root, split.pkg, plan.target),
        path.join(pkgRoot, plan.target),
        budget,
      );
    } else {
      const dir = path.posix.dirname(plan.target);
      const base = path.posix.basename(plan.target);
      const srcDir = path.join(root, split.pkg, dir);
      const outDir = path.join(pkgRoot, dir);
      await fs.mkdir(outDir, { recursive: true });
      const stem = sameStemPrefix(base);
      const names = await fs.readdir(srcDir).catch(() => [] as string[]);
      for (const n of names) {
        if (n !== base && !n.startsWith(stem)) continue;
        const st = await fs.stat(path.join(srcDir, n)).catch(() => null);
        if (!st?.isFile()) continue;
        await fs.copyFile(path.join(srcDir, n), path.join(outDir, n));
      }
    }

    const target = path.join(pkgRoot, split.rest);
    if (!(await fs.stat(target).catch(() => null))) {
      return {
        org: null,
        local,
        error: "file not found on disk - nothing to compare",
      };
    }

    // Every argument is a literal. "pkg" holds only this component, so
    // retrieving the whole package directory retrieves exactly it.
    const { stdout, stderr, ok } = await runSf(
      [
        "project",
        "retrieve",
        "start",
        "--source-dir",
        "pkg",
        "--ignore-conflicts",
        "--json",
        "--wait",
        String(Math.max(2, Math.ceil(timeoutMs / 60_000))),
      ],
      sandbox,
      timeoutMs,
    );

    const outcome = readRetrieveOutcome(stdout, ok);
    if (!outcome.ok) {
      return {
        org: null,
        local,
        error: outcome.error ?? ((stderr || stdout).slice(-600) || "retrieve failed"),
      };
    }
    const now = Date.now();
    const parsed = parseSfJson(stdout);
    const first = (parsed?.result?.files ?? [])[0];
    const type = typeof first?.type === "string" ? first.type : undefined;

    if (outcome.missing) {
      // "Not in the org" is a real answer and worth caching too, so a locally
      // new file does not pay 15s again on the next look.
      cachePut(root, rel, { org: null, type, at: now });
      return { org: null, local, type, fetchedAt: now };
    }

    // Harvest the WHOLE component, not just the file asked for. The retrieve
    // already paid for all of it, so caching the siblings makes comparing the
    // second file of a bundle free instead of another 15s.
    await harvestSandbox(sandbox, root, split.pkg, now, type);

    const orgContent = await fs.readFile(target, "utf8").catch(() => null);
    if (orgContent === null) {
      // The component came back but this particular file did not - a bundle
      // whose org version no longer has this piece. Deleted in the org, then.
      cachePut(root, rel, { org: null, type, at: now });
      return { org: null, local, type, fetchedAt: now };
    }
    return { org: orgContent, local, type, fetchedAt: now };
  } catch (e) {
    return { org: null, local, error: String(e instanceof Error ? e.message : e) };
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}
