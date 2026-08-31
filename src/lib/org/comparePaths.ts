import { promises as fs } from "node:fs";
import path from "node:path";

/** Path arithmetic for the compare: which package directory a file belongs to,
 * and what has to be copied for sf to recognise a component.
 *
 * Pure except for reading sfdx-project.json, and therefore the part of the
 * compare that is fully covered by tests without an org or a CLI. */

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
export const MAX_COPY_FILES = 800;
export const MAX_COPY_BYTES = 25_000_000;

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

