import { execFile } from "node:child_process";
import { getOrgConnection } from "@/lib/org/connection";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Distinguishes two manifests written in the same millisecond by the same
 * process - a per-member retrieve fired from two tree rows at once. */
let seq = 0;

/** The org side of the file tree - what Salesforce holds, rather than what is
 * on disk. This is the VS Code "Org Browser" data source: list the types, list
 * a type's members on demand, and retrieve one member (or a whole type) into
 * the project.
 *
 * Two rules run through all of it, both learned from real failures:
 *
 * 1. An empty answer is a normal answer. A type with no members, an org with a
 *    type this API version does not know, a folder with nothing in it - none of
 *    those is an error, and none may fail the caller. sf itself exits non-zero
 *    with "No metadata found" for an empty type, so a naive !err check turns an
 *    empty ApexPage folder into a red banner.
 * 2. Listing is read-only. Nothing here deploys, deletes or modifies the org.
 *    The only write is onto the local disk, by retrieve. */

export interface MetaType {
  /** the API name, e.g. "ApexClass" - what --metadata-type takes */
  name: string;
  /** the source folder the type lands in, e.g. "classes" */
  directoryName: string;
  /** members live inside folders (Report, Dashboard, Document, EmailTemplate)
   * and cannot be listed without naming a folder first */
  inFolder: boolean;
  suffix?: string;
  children: string[];
}

export interface MetaMember {
  fullName: string;
  type: string;
  /** org-side path, e.g. "classes/AccountService.cls" */
  fileName?: string;
  lastModifiedByName?: string;
  lastModifiedDate?: string;
  /** "installed" means it came from a managed package - present in the org,
   * usually not editable, and worth a chip in the UI rather than a surprise */
  manageableState?: string;
  namespacePrefix?: string;
}

/** Folder-based types name their folder type irregularly: three of the four
 * append "Folder", EmailTemplate uses "EmailFolder". Getting this wrong makes
 * the type look EMPTY rather than erroring, which is why it is a table. */
const FOLDER_TYPE: Record<string, string> = {
  Report: "ReportFolder",
  Dashboard: "DashboardFolder",
  Document: "DocumentFolder",
  EmailTemplate: "EmailFolder",
};

export function folderTypeFor(type: string): string {
  return FOLDER_TYPE[type] ?? type + "Folder";
}

/** sf writes JSON to stdout but prefixes warnings (a CLI update notice) and
 * colorizes when FORCE_COLOR is set, which Next's dev server does. Accepts an
 * object or an array payload - `list metadata` returns an array result. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSfJson(stdout: string): any | null {
  const clean = stdout.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
  const start = clean.search(/[{[]/);
  if (start < 0) return null;
  try {
    return JSON.parse(clean.slice(start));
  } catch {
    return null;
  }
}

export function runSf(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  return new Promise((resolve) => {
    // shell:true so Windows resolves sf.cmd. Every arg here is either a fixed
    // string or an API name already validated by isApiName - never raw input.
    execFile(
      "sf",
      args,
      {
        cwd,
        timeout: timeoutMs,
        shell: true,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) =>
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", ok: !err }),
    );
  });
}

/** A metadata TYPE name - what --metadata-type takes. Always a plain
 * identifier, so the gate can be strict. It has to be: the arg reaches a shell
 * through shell:true. */
export function isApiName(s: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(s) && s.length <= 100;
}

/** A FOLDER name - what --folder takes. Cannot use the strict gate above,
 * because Salesforce's own folder for unfiled reports and templates is
 * literally "unfiled$public". Dollars and dots are therefore allowed, while
 * everything a shell would act on is not - including "%", which cmd.exe reads
 * as a variable reference. */
export function isFolderName(s: string): boolean {
  return /^[A-Za-z0-9_$.-]+$/.test(s) && s.length > 0 && s.length <= 100;
}

/** A MEMBER name is never validated against a character set, because real ones
 * legitimately contain spaces and percent-escapes - a layout is named
 * "Account-Account %28Marketing%29 Layout". They are safe because they never
 * reach a command line: retrieve writes them into a manifest as XML text. The
 * only limits are the ones XML itself cannot carry. */
export function isMemberName(s: string): boolean {
  if (s.length === 0 || s.length > 400) return false;
  // No angle brackets (they would break out of the XML element) and no
  // control characters (XML 1.0 cannot carry them at all).
  if (s.includes("<") || s.includes(">")) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09) return false;
  }
  return true;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Every type the org will hand over, sorted for a browsable tree.
 * `--filter-known` is deliberately NOT passed: it hides types the local sf
 * build has no source mapping for, which is exactly the metadata someone opens
 * an org browser to discover. */
export async function listTypes(cwd: string): Promise<MetaType[]> {
  // In-process first. `sf org list metadata-types` is a describeMetadata call
  // wrapped in a 6-second process start; the same call on a live connection
  // measured 0.60s. The CLI stays as the fallback, so an unauthenticated or
  // unusable connection costs nothing but the old speed.
  const viaApi = await listTypesViaApi(cwd);
  if (viaApi) return viaApi;

  const { stdout } = await runSf(["org", "list", "metadata-types", "--json"], cwd, 120_000);
  const parsed = parseSfJson(stdout);
  const objects = parsed?.result?.metadataObjects ?? parsed?.metadataObjects;
  if (!Array.isArray(objects)) return [];
  return objects
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((o: any) => typeof o?.xmlName === "string")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((o: any) => ({
      name: o.xmlName as string,
      directoryName: typeof o.directoryName === "string" ? o.directoryName : "",
      inFolder: o.inFolder === true,
      suffix: typeof o.suffix === "string" ? o.suffix : undefined,
      children: Array.isArray(o.childXmlNames)
        ? o.childXmlNames.filter((c: unknown) => typeof c === "string")
        : [],
    }))
    .sort((a: MetaType, b: MetaType) => a.name.localeCompare(b.name));
}

/** describeMetadata over a live connection.
 *
 * Returns null - never an empty list - when it cannot answer, because an empty
 * list is a MEANINGFUL result here (rule 1 at the top of this file) and would
 * be indistinguishable from "the connection failed". The caller needs to tell
 * those apart to know whether to fall back. */
async function listTypesViaApi(cwd: string): Promise<MetaType[] | null> {
  const got = await getOrgConnection(cwd);
  if (!got.ok) return null;
  try {
    const res = await got.org.conn.metadata.describe();
    const objects = res?.metadataObjects;
    if (!Array.isArray(objects)) return null;
    return normalizeTypes(objects);
  } catch {
    return null;
  }
}

/** The describe payload has the same field names from the CLI and from the API,
 * so one normaliser serves both and the two paths cannot drift. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeTypes(objects: any[]): MetaType[] {
  return objects
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((o: any) => typeof o?.xmlName === "string")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((o: any) => ({
      name: o.xmlName as string,
      directoryName: typeof o.directoryName === "string" ? o.directoryName : "",
      inFolder: o.inFolder === true || o.inFolder === "true",
      suffix: typeof o.suffix === "string" ? o.suffix : undefined,
      children: Array.isArray(o.childXmlNames)
        ? o.childXmlNames.filter((c: unknown) => typeof c === "string")
        : typeof o.childXmlNames === "string"
          ? [o.childXmlNames]
          : [],
    }))
    .sort((a: MetaType, b: MetaType) => a.name.localeCompare(b.name));
}

/** One type's members. Empty is a valid answer - see rule 1 at the top.
 * For a folder-based type this walks the folders and concatenates, because the
 * API refuses a folder-less listing and would otherwise report nothing. */
export async function listMembers(
  cwd: string,
  type: string,
  inFolder: boolean,
): Promise<MetaMember[]> {
  if (!isApiName(type)) return [];
  if (!inFolder) return listOne(cwd, type);

  const folders = await listOne(cwd, folderTypeFor(type));
  const out: MetaMember[] = [];
  for (const f of folders) {
    if (!isFolderName(f.fullName)) continue;
    out.push(...(await listOne(cwd, type, f.fullName)));
  }
  return dedupe(out);
}

async function listOne(cwd: string, type: string, folder?: string): Promise<MetaMember[]> {
  const viaApi = await listOneViaApi(cwd, type, folder);
  if (viaApi) return viaApi;

  const args = ["org", "list", "metadata", "--metadata-type", type];
  if (folder) args.push("--folder", folder);
  args.push("--json");
  const { stdout } = await runSf(args, cwd, 120_000);
  const parsed = parseSfJson(stdout);
  const result = parsed?.result ?? parsed;
  // Not an array means the org has no members of this type (sf exits non-zero
  // saying "No metadata found"). That is not a failure and must never surface
  // as one - rule 1. The type simply shows as empty.
  if (!Array.isArray(result)) return [];
  return result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => typeof m?.fullName === "string")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => ({
      fullName: m.fullName as string,
      type: typeof m.type === "string" ? m.type : type,
      fileName: typeof m.fileName === "string" ? m.fileName : undefined,
      lastModifiedByName:
        typeof m.lastModifiedByName === "string" ? m.lastModifiedByName : undefined,
      lastModifiedDate: typeof m.lastModifiedDate === "string" ? m.lastModifiedDate : undefined,
      manageableState: typeof m.manageableState === "string" ? m.manageableState : undefined,
      namespacePrefix: typeof m.namespacePrefix === "string" ? m.namespacePrefix : undefined,
    }))
    .sort((a: MetaMember, b: MetaMember) => a.fullName.localeCompare(b.fullName));
}

/** listMetadata over a live connection. Null means "could not answer", so an
 * empty type still reads as empty rather than as a failure. */
async function listOneViaApi(
  cwd: string,
  type: string,
  folder?: string,
): Promise<MetaMember[] | null> {
  if (!isApiName(type)) return null;
  if (folder && !isFolderName(folder)) return null;
  const got = await getOrgConnection(cwd);
  if (!got.ok) return null;
  try {
    const res = await got.org.conn.metadata.list(
      [folder ? { type, folder } : { type }],
      got.org.conn.getApiVersion(),
    );
    // A type with no members comes back as undefined or a bare object rather
    // than an array; both mean "empty", which is a real answer.
    const rows = Array.isArray(res) ? res : res ? [res] : [];
    return normalizeMembers(rows, type);
  } catch {
    return null;
  }
}

/** Same field names from the CLI and the API, so one normaliser again. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMembers(rows: any[], type: string): MetaMember[] {
  return rows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => typeof m?.fullName === "string")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => ({
      fullName: m.fullName as string,
      type: typeof m.type === "string" ? m.type : type,
      fileName: typeof m.fileName === "string" ? m.fileName : undefined,
      lastModifiedByName:
        typeof m.lastModifiedByName === "string" ? m.lastModifiedByName : undefined,
      lastModifiedDate: typeof m.lastModifiedDate === "string" ? m.lastModifiedDate : undefined,
      manageableState: typeof m.manageableState === "string" ? m.manageableState : undefined,
      namespacePrefix: typeof m.namespacePrefix === "string" ? m.namespacePrefix : undefined,
    }))
    .sort((a: MetaMember, b: MetaMember) => a.fullName.localeCompare(b.fullName));
}

function dedupe(members: MetaMember[]): MetaMember[] {
  const seen = new Set<string>();
  return members.filter((m) => {
    const key = m.type + ":" + m.fullName;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Build a package.xml for a set of "Type" / "Type:Member" specs.
 *
 * Retrieve goes through a manifest rather than repeated --metadata flags for
 * one reason: real component names are not shell-safe. A layout is named
 * "Account-Account %28Marketing%29 Layout" and the folder for unfiled reports
 * is "unfiled$public" - spaces, percent-escapes and dollars, every one of them
 * meaningful to cmd.exe and to sh. Validating them away would refuse
 * legitimate components; passing them through would be an injection. In a
 * manifest they are XML text, escaped, and no shell ever sees them.
 *
 * A bare "Type" becomes the wildcard member, which is how a whole type is
 * retrieved. */
export function buildManifest(specs: string[], apiVersion: string): string {
  const byType = new Map<string, string[]>();
  for (const spec of specs) {
    const idx = spec.indexOf(":");
    const type = idx < 0 ? spec : spec.slice(0, idx);
    const member = idx < 0 ? "*" : spec.slice(idx + 1);
    if (!isApiName(type)) continue;
    if (member !== "*" && !isMemberName(member)) continue;
    const list = byType.get(type) ?? [];
    if (!list.includes(member)) list.push(member);
    byType.set(type, list);
  }

  const parts = ['<?xml version="1.0" encoding="UTF-8"?>'];
  parts.push('<Package xmlns="http://soap.sforce.com/2006/04/metadata">');
  for (const [type, members] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push("    <types>");
    // A wildcard makes every named member redundant, so it stands alone.
    const list = members.includes("*") ? ["*"] : members;
    for (const m of list) parts.push("        <members>" + xmlEscape(m) + "</members>");
    parts.push("        <name>" + xmlEscape(type) + "</name>");
    parts.push("    </types>");
  }
  parts.push("    <version>" + xmlEscape(apiVersion) + "</version>");
  parts.push("</Package>");
  return parts.join("\n") + "\n";
}

/** The API version the manifest declares. sfdx-project.json is the project's
 * own answer; the fallback only matters for a project that does not pin one. */
export const FALLBACK_API_VERSION = "62.0";

export async function projectApiVersion(cwd: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(cwd, "sfdx-project.json"), "utf8");
    const v = JSON.parse(raw)?.sourceApiVersion;
    if (typeof v === "string" && /^\d+\.\d+$/.test(v)) return v;
  } catch {
    /* no project file, or unreadable - the fallback is the answer */
  }
  return FALLBACK_API_VERSION;
}

/** Retrieve into the project. A "Type:Member" spec retrieves that one
 * component; a bare "Type" retrieves the whole type. Returns sf's own words on
 * failure, because "retrieve failed" without them is unactionable. */
export async function retrieveMetadata(
  cwd: string,
  specs: string[],
  timeoutMs = 600_000,
): Promise<{ ok: boolean; output: string; files: number }> {
  const manifest = buildManifest(specs, await projectApiVersion(cwd));
  if (!manifest.includes("<types>")) {
    return { ok: false, output: "nothing valid to retrieve", files: 0 };
  }

  // The manifest path is generated here, never supplied - it is the only part
  // of the command line that varies, and it stays inside .dhruva/tmp with a
  // name that cannot contain a shell character.
  const rel = ".dhruva/tmp/org-retrieve-" + process.pid + "-" + (seq++) + ".xml";
  const abs = path.join(cwd, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, manifest, "utf8");

  const args = [
    "project",
    "retrieve",
    "start",
    "--manifest",
    rel,
    "--json",
    "--wait",
    String(Math.max(2, Math.ceil(timeoutMs / 60_000))),
  ];

  const { stdout, stderr, ok } = await runSf(args, cwd, timeoutMs);
  await fs.rm(abs, { force: true }).catch(() => {});
  const parsed = parseSfJson(stdout);
  const files = parsed?.result?.files;
  if (ok && Array.isArray(files)) {
    return { ok: true, output: files.length + " file(s) retrieved", files: files.length };
  }
  const msg = parsed?.message ?? parsed?.name ?? (stderr || stdout).slice(-1500);
  return { ok: false, output: String(msg || "no output from sf"), files: 0 };
}

/** Split the type list into retrieve batches.
 *
 * A whole-org retrieve in one call is the obvious implementation and the wrong
 * one. The Metadata API caps a single retrieve (10,000 files / 39 MB), and one
 * unsupported type fails the ENTIRE call - so a 90-type org gives you nothing
 * after twenty minutes, with no clue which type broke it. Measured on a real
 * project whose full manifest is 6.5 MB across 84 types, which its team had
 * already hand-split into ten files for exactly this reason.
 *
 * Batching keeps each call inside the cap and makes failure partial and named:
 * a bad type costs its own batch, not the run. */
export const BATCH_TYPES = 8;

/** Narrow a retrieve to the types the caller asked for.
 *
 * The org's own list is the authority on what exists and in what order, so the
 * request is intersected with it rather than trusted: a caller naming a type
 * this org does not have would otherwise spend a whole batch failing on it.
 * No request means everything, which is the full-org case. */
export function scopeTypes(all: string[], requested?: string[]): string[] {
  if (!requested || requested.length === 0) return all;
  const want = new Set(requested);
  return all.filter((t) => want.has(t));
}

/** Drop types another running retrieve has already claimed.
 *
 * Two concurrent retrieves of the same type write the same files in the same
 * folder, and the loser's output lands on top of the winner's half-written
 * state. Groups are disjoint by construction - a type belongs to exactly one -
 * but "full org" overlaps every group, so the overlap is real as soon as more
 * than one retrieve may run. Skipping is right rather than refusing: the rest
 * of the request is still worth doing, and the caller is told what was left
 * out. */
export function excludeClaimed(
  requested: string[],
  claimed: Iterable<string>,
): { types: string[]; skipped: string[] } {
  const taken = new Set(claimed);
  const types: string[] = [];
  const skipped: string[] = [];
  for (const t of requested) (taken.has(t) ? skipped : types).push(t);
  return { types, skipped };
}

export function retrieveBatches(types: string[], size = BATCH_TYPES): string[][] {
  const out: string[][] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < types.length; i += step) out.push(types.slice(i, i + step));
  return out;
}
