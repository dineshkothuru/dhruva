/** Fetch a component's source straight out of the org with one Tooling API
 * query, instead of a Metadata API retrieve.
 *
 * A Metadata API retrieve is the general mechanism: it works for every type,
 * and it costs a zip round trip. But the things people actually sit and compare
 * - Apex, LWC, Aura, Visualforce - all keep their source in Tooling API objects
 * that a single SOQL returns. Measured against a real org: 0.30s for a class,
 * 0.40s for a whole LWC bundle, versus ~15s through the CLI.
 *
 * Everything not in the table below falls back to the retrieve path, which is
 * why this can be an incomplete fast path without being a broken one. */

export type SourceKind = "apex" | "lwc" | "aura";

export interface ToolingTarget {
  kind: SourceKind;
  /** Tooling API sObject to query. */
  object: string;
  /** The field holding the source text. */
  field: string;
  /** Component (or bundle) developer name. */
  name: string;
  /** For aura: which definition inside the bundle. */
  defType?: string;
  /** Project-relative directory the component's files live in, used to key
   * results back onto file paths. */
  dir: string;
}

/** Aura stores each file of a bundle as a row with a DefType rather than a
 * path, so the extension and suffix have to be mapped back. The order matters:
 * `FooController.js` must be tested before the bare `.js` cases. */
function auraDefType(fileName: string, bundle: string): string | null {
  const lower = fileName.toLowerCase();
  const b = bundle.toLowerCase();
  if (lower === `${b}controller.js`) return "CONTROLLER";
  if (lower === `${b}helper.js`) return "HELPER";
  if (lower === `${b}renderer.js`) return "RENDERER";
  if (lower.endsWith(".cmp")) return "COMPONENT";
  if (lower.endsWith(".app")) return "APPLICATION";
  if (lower.endsWith(".evt")) return "EVENT";
  if (lower.endsWith(".intf")) return "INTERFACE";
  if (lower.endsWith(".css")) return "STYLE";
  if (lower.endsWith(".auradoc")) return "DOCUMENTATION";
  if (lower.endsWith(".design")) return "DESIGN";
  if (lower.endsWith(".svg")) return "SVG";
  if (lower.endsWith(".tokens")) return "TOKENS";
  return null;
}

/** Which Tooling API query, if any, returns this file's org-side source.
 *
 * `rest` is the path below the package directory, e.g.
 * "main/default/classes/Foo.cls". Returns null for anything the fast path does
 * not cover, and the caller then uses the retrieve fallback. */
export function toolingTargetFor(rest: string): ToolingTarget | null {
  const segs = rest.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const file = segs[segs.length - 1];
  const dir = segs.slice(0, -1).join("/");

  // A component inside a bundle folder: .../lwc/<bundle>/<file>
  const parent = segs[segs.length - 2];
  const grandparent = segs.length >= 3 ? segs[segs.length - 3] : "";

  if (grandparent === "lwc") {
    // One query returns the whole bundle, including the .js-meta.xml, so the
    // file name is not part of the query at all - it only selects which row to
    // read afterwards.
    return {
      kind: "lwc",
      object: "LightningComponentResource",
      field: "Source",
      name: parent,
      dir: segs.slice(0, -1).join("/"),
    };
  }

  if (grandparent === "aura") {
    const defType = auraDefType(file, parent);
    if (!defType) return null;
    return {
      kind: "aura",
      object: "AuraDefinition",
      field: "Source",
      name: parent,
      defType,
      dir: segs.slice(0, -1).join("/"),
    };
  }

  // Flat, single-file types. The metadata companion (-meta.xml) is NOT in the
  // Tooling API for these, so it deliberately falls through to the retrieve.
  const flat: Record<string, { object: string; field: string; suffix: string }> = {
    classes: { object: "ApexClass", field: "Body", suffix: ".cls" },
    triggers: { object: "ApexTrigger", field: "Body", suffix: ".trigger" },
    pages: { object: "ApexPage", field: "Markup", suffix: ".page" },
    components: { object: "ApexComponent", field: "Markup", suffix: ".component" },
  };
  const hit = flat[parent];
  if (hit && file.toLowerCase().endsWith(hit.suffix)) {
    return {
      kind: "apex",
      object: hit.object,
      field: hit.field,
      name: file.slice(0, file.length - hit.suffix.length),
      dir,
    };
  }
  return null;
}

/** A developer name reaching a SOQL string has to be an identifier and nothing
 * else. Apex and Aura API names always are; the check is here because the value
 * comes from a file path, and a path is not a promise. */
export function isQueryableName(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(s);
}

/** The SOQL for a target. Separated from execution so the exact text is
 * testable - a wrong field name here is a silent fallback to the 15s path. */
export function soqlFor(t: ToolingTarget): string | null {
  if (!isQueryableName(t.name)) return null;
  switch (t.kind) {
    case "apex":
      return `SELECT ${t.field} FROM ${t.object} WHERE Name = '${t.name}' AND NamespacePrefix = null`;
    case "lwc":
      return `SELECT FilePath, ${t.field} FROM ${t.object} WHERE LightningComponentBundle.DeveloperName = '${t.name}'`;
    case "aura":
      if (!t.defType) return null;
      return `SELECT DefType, ${t.field} FROM ${t.object} WHERE AuraDefinitionBundle.DeveloperName = '${t.name}' AND DefType = '${t.defType}'`;
  }
}

/** Aura's DefType back to the file name it corresponds to on disk. */
export function auraFileName(bundle: string, defType: string): string | null {
  switch (defType) {
    case "COMPONENT":
      return `${bundle}.cmp`;
    case "APPLICATION":
      return `${bundle}.app`;
    case "EVENT":
      return `${bundle}.evt`;
    case "INTERFACE":
      return `${bundle}.intf`;
    case "CONTROLLER":
      return `${bundle}Controller.js`;
    case "HELPER":
      return `${bundle}Helper.js`;
    case "RENDERER":
      return `${bundle}Renderer.js`;
    case "STYLE":
      return `${bundle}.css`;
    case "DOCUMENTATION":
      return `${bundle}.auradoc`;
    case "DESIGN":
      return `${bundle}.design`;
    case "SVG":
      return `${bundle}.svg`;
    case "TOKENS":
      return `${bundle}.tokens`;
    default:
      return null;
  }
}

/** Turn query rows into project-relative path → source.
 *
 * Pure, because this is where the two awkward shapes get normalised: LWC rows
 * carry a FilePath of the form "lwc/<bundle>/<file>" which has to be re-rooted
 * onto the project's own directory, and Aura rows carry no path at all. */
export function rowsToFiles(
  t: ToolingTarget,
  pkgDir: string,
  rows: Record<string, unknown>[],
): Map<string, string> {
  const out = new Map<string, string>();
  const prefix = `${pkgDir}/${t.dir}`;

  if (t.kind === "apex") {
    const src = rows[0]?.[t.field];
    if (typeof src === "string") {
      out.set(`${prefix}/${t.name}${suffixForApex(t.object)}`, src);
    }
    return out;
  }

  if (t.kind === "lwc") {
    for (const r of rows) {
      const fp = typeof r.FilePath === "string" ? r.FilePath : "";
      const src = r[t.field];
      if (!fp || typeof src !== "string") continue;
      // "lwc/adminTools/adminTools.html" -> just the file name; the directory
      // is already known and may sit under any package/main/default layout.
      const name = fp.split("/").pop();
      if (!name) continue;
      out.set(`${prefix}/${name}`, src);
    }
    return out;
  }

  for (const r of rows) {
    const defType = typeof r.DefType === "string" ? r.DefType : "";
    const src = r[t.field];
    if (!defType || typeof src !== "string") continue;
    const name = auraFileName(t.name, defType);
    if (name) out.set(`${prefix}/${name}`, src);
  }
  return out;
}

function suffixForApex(object: string): string {
  switch (object) {
    case "ApexClass":
      return ".cls";
    case "ApexTrigger":
      return ".trigger";
    case "ApexPage":
      return ".page";
    case "ApexComponent":
      return ".component";
    default:
      return "";
  }
}
