import { promises as fs } from "node:fs";
import path from "node:path";
import { parseSfJson, runSf } from "@/lib/orgMetadata";
import { packageDirs } from "@/lib/orgCompare";

/** Create a new metadata component locally, from Salesforce's own templates.
 *
 * This shells out to `sf template generate ...` - the same @salesforce/templates
 * engine behind VS Code's "SFDX: Create Apex Class". The skeletons are
 * therefore Salesforce's, not ours: a class comes out with the api version the
 * project pins, an LWC comes out as a proper three-file bundle with its
 * .js-meta.xml, and none of it drifts when Salesforce changes a template.
 * Writing those files by hand here would be a slowly-rotting copy.
 *
 * It also keeps an existing decision intact rather than working around it.
 * /api/file deliberately refuses to create files - "creating files stays with
 * the agent/CLI" - so creation goes through the CLI, which is exactly where
 * that comment points.
 *
 * Nothing here talks to an org. Templates are local scaffolding: no network, no
 * deploy, no credential. The only effect is new files on disk. */

/** Trigger events, as the CLI spells them. A fixed list because it is also the
 * gate: these strings contain spaces and reach a shell, so they may only ever
 * be one of these exact values. */
export const TRIGGER_EVENTS = [
  "before insert",
  "before update",
  "before delete",
  "after insert",
  "after update",
  "after delete",
  "after undelete",
] as const;

/** Static resource content types. A whitelist rather than a text field for the
 * same reason - and because a free-text mime type is a support ticket, not a
 * feature. */
export const STATIC_RESOURCE_TYPES = [
  "application/zip",
  "application/json",
  "text/javascript",
  "text/css",
  "text/plain",
  "image/png",
  "image/svg+xml",
] as const;

/** What `sf template generate static-resource` actually names the CONTENT file
 * for each content type. Read off a real CLI, one run per type, because none of
 * it is guessable: svg+xml does NOT get a .svg, and application/zip gets no
 * file at all - it gets a FOLDER (with a .gitkeep, so git can see it) whose
 * contents are zipped at deploy time.
 *
 * This table exists because of a real bug: the create dialog opened
 * `<name>.resource-meta.xml` afterwards, so a new static resource looked like
 * it had no content file when in fact sf had written one right next to it. The
 * file was there; the app just never showed it. */
const STATIC_RESOURCE_EXT: Record<string, string | null> = {
  "application/zip": null, // a folder, not a file
  "application/json": "json",
  "text/javascript": "js",
  "text/css": "css",
  "text/plain": "txt",
  "image/png": "resource",
  "image/svg+xml": "resource",
};

/** True when this content type produces a folder to drop files into rather
 * than a file to edit - the dialog says so, because otherwise "where is my
 * file?" is the obvious next question. */
export function isFolderResource(mime: string): boolean {
  return STATIC_RESOURCE_EXT[mime] === null;
}

export type ExtraField = "sobject" | "events" | "label" | "mime";

export interface CreateType {
  id: string;
  label: string;
  group: "Apex" | "Lightning" | "Visualforce" | "Other";
  /** The fixed sf sub-command and any fixed flags. Never interpolated. */
  command: string[];
  /** Source folder the component lands in, under <pkg>/main/default. */
  dir: string;
  /** --template options. Empty means the command takes no --template. */
  templates: string[];
  /** Extra flags this type requires. */
  needs: ExtraField[];
  /** Apex and Aura are PascalCase; an LWC folder must start lowercase. */
  nameStyle: "pascal" | "camel";
  /** TemplateType key in @salesforce/templates, for the in-process fast path. */
  tplType: string;
  /** Options object for that generator. Key names differ per generator and
   * were read off the library, not guessed - a wrong key throws ENOENT on a
   * path containing the word "undefined". */
  tplOpts: (a: { name: string; template: string; mime: string; outputDir: string; sobject: string; events: string[]; label: string }) => Record<string, unknown>;
  /** The file worth opening in the editor afterwards, relative to `dir`.
   * Null when the type produces no editable file (a zip static resource is a
   * folder), in which case the create still succeeds and the tree shows it. */
  primaryFile: (name: string, template: string, mime: string) => string | null;
}

/** The catalogue. Every command and flag here was read off `sf ... --help` on a
 * real CLI rather than assumed, because a wrong required flag would show up as
 * a menu entry that always fails.
 *
 * Deliberately NOT included yet: flexipage, digital-experience site, analytics
 * template and ui-bundle. Each has a larger or conditionally-required flag
 * surface (a FlexiPage needs a template AND, for RecordPage, an sobject), and a
 * half-modelled entry is worse than an absent one. Each is one row here plus
 * its fields when wanted. */
export const CREATE_TYPES: CreateType[] = [
  {
    id: "apex-class",
    label: "Apex Class",
    group: "Apex",
    command: ["template", "generate", "apex", "class"],
    dir: "classes",
    templates: [
      "DefaultApexClass",
      "ApexUnitTest",
      "BasicUnitTest",
      "Batchable",
      "Queueable",
      "ApexException",
      "InboundEmailService",
    ],
    needs: [],
    nameStyle: "pascal",
    tplType: "ApexClass",
    tplOpts: (a) => ({ classname: a.name, template: a.template, outputdir: a.outputDir }),
    primaryFile: (n) => `${n}.cls`,
  },
  {
    id: "apex-trigger",
    label: "Apex Trigger",
    group: "Apex",
    command: ["template", "generate", "apex", "trigger"],
    dir: "triggers",
    templates: ["ApexTrigger"],
    needs: ["sobject", "events"],
    nameStyle: "pascal",
    tplType: "ApexTrigger",
    tplOpts: (a) => ({
      triggername: a.name,
      template: a.template,
      sobject: a.sobject,
      triggerevents: a.events,
      outputdir: a.outputDir,
    }),
    primaryFile: (n) => `${n}.trigger`,
  },
  {
    id: "lwc",
    label: "Lightning Web Component",
    group: "Lightning",
    command: ["template", "generate", "lightning", "component", "--type", "lwc"],
    dir: "lwc",
    templates: ["default", "typescript", "analyticsDashboard", "analyticsDashboardWithStep"],
    needs: [],
    nameStyle: "camel",
    tplType: "LightningComponent",
    tplOpts: (a) => ({ componentname: a.name, template: a.template, type: "lwc", outputdir: a.outputDir }),
    // The typescript template emits .ts instead of .js - opening the wrong one
    // would land the user on a "file not found" straight after a success.
    primaryFile: (n, t) => `${n}/${n}.${t === "typescript" ? "ts" : "js"}`,
  },
  {
    id: "aura",
    label: "Aura Component",
    group: "Lightning",
    command: ["template", "generate", "lightning", "component", "--type", "aura"],
    dir: "aura",
    templates: ["default"],
    needs: [],
    nameStyle: "pascal",
    tplType: "LightningComponent",
    tplOpts: (a) => ({ componentname: a.name, template: a.template, type: "aura", outputdir: a.outputDir }),
    primaryFile: (n) => `${n}/${n}.cmp`,
  },
  {
    id: "lightning-app",
    label: "Aura App",
    group: "Lightning",
    command: ["template", "generate", "lightning", "app"],
    dir: "aura",
    templates: ["DefaultLightningApp"],
    needs: [],
    nameStyle: "pascal",
    tplType: "LightningApp",
    tplOpts: (a) => ({ appname: a.name, template: a.template, outputdir: a.outputDir }),
    primaryFile: (n) => `${n}/${n}.app`,
  },
  {
    id: "lightning-event",
    label: "Aura Event",
    group: "Lightning",
    command: ["template", "generate", "lightning", "event"],
    dir: "aura",
    templates: ["DefaultLightningEvt"],
    needs: [],
    nameStyle: "pascal",
    tplType: "LightningEvent",
    tplOpts: (a) => ({ eventname: a.name, template: a.template, outputdir: a.outputDir }),
    primaryFile: (n) => `${n}/${n}.evt`,
  },
  {
    id: "lightning-interface",
    label: "Aura Interface",
    group: "Lightning",
    command: ["template", "generate", "lightning", "interface"],
    dir: "aura",
    templates: ["DefaultLightningIntf"],
    needs: [],
    nameStyle: "pascal",
    tplType: "LightningInterface",
    tplOpts: (a) => ({ interfacename: a.name, template: a.template, outputdir: a.outputDir }),
    primaryFile: (n) => `${n}/${n}.intf`,
  },
  {
    id: "vf-page",
    label: "Visualforce Page",
    group: "Visualforce",
    command: ["template", "generate", "visualforce", "page"],
    dir: "pages",
    templates: [],
    needs: ["label"],
    nameStyle: "pascal",
    tplType: "VisualforcePage",
    // The CLI exposes no --template for a VF page, but the library REQUIRES
    // one and defaults it to undefined, which surfaces as an ENOENT on a path
    // literally containing "undefined.page". Supplied here rather than in the
    // templates list, so the dialog and the CLI contract stay unchanged.
    tplOpts: (a) => ({
      pagename: a.name,
      label: a.label,
      template: "DefaultVFPage",
      outputdir: a.outputDir,
    }),
    primaryFile: (n) => `${n}.page`,
  },
  {
    id: "vf-component",
    label: "Visualforce Component",
    group: "Visualforce",
    command: ["template", "generate", "visualforce", "component"],
    dir: "components",
    templates: ["DefaultVFComponent"],
    needs: ["label"],
    nameStyle: "pascal",
    tplType: "VisualforceComponent",
    tplOpts: (a) => ({
      componentname: a.name,
      label: a.label,
      template: a.template,
      outputdir: a.outputDir,
    }),
    primaryFile: (n) => `${n}.component`,
  },
  {
    id: "static-resource",
    label: "Static Resource",
    group: "Other",
    command: ["template", "generate", "static-resource"],
    dir: "staticresources",
    templates: [],
    needs: ["mime"],
    nameStyle: "pascal",
    tplType: "StaticResource",
    tplOpts: (a) => ({ resourcename: a.name, contenttype: a.mime, outputdir: a.outputDir }),
    // The content file - which is the whole point of a static resource. The
    // placeholder sf writes into it even says "replace this file with your
    // static resource", so it is exactly what the user should land on.
    primaryFile: (n, _t, mime) => {
      const ext = STATIC_RESOURCE_EXT[mime];
      return ext ? `${n}.${ext}` : null;
    },
  },
];

export function findType(id: unknown): CreateType | null {
  return CREATE_TYPES.find((t) => t.id === id) ?? null;
}

/** Every validator below exists because runSf reaches a shell on Windows.
 *
 * The rule applied throughout: a value either matches a charset with no shell
 * metacharacter in it at all, or it is not a value. Quoting is then belt to the
 * validator's braces rather than the only defence - which matters, because
 * `%` alone is enough to make cmd.exe interpolate, and no amount of quoting
 * saves you from it. */

/** Apex and Aura names are PascalCase identifiers; an LWC folder name must
 * start lowercase or the bundle will not load. Salesforce caps API names at 40
 * characters, but the CLI is the authority on that - this only has to be
 * strict, and strict is a plain identifier. */
export function validName(name: string, style: "pascal" | "camel"): boolean {
  if (style === "pascal") return /^[A-Z][A-Za-z0-9_]{0,79}$/.test(name);
  return /^[a-z][A-Za-z0-9_]{0,79}$/.test(name);
}

/** Account, Case, My_Object__c - an identifier, nothing more. */
export function validSobject(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(s);
}

/** A Visualforce label is the one genuinely human string here, so it allows
 * spaces and a few punctuation marks - and nothing a shell acts on. */
export function validLabel(s: string): boolean {
  return /^[A-Za-z0-9 ()._-]{1,80}$/.test(s);
}

/** A package directory comes from sfdx-project.json rather than from a form,
 * but it is still not ours, and it still reaches the command line. */
export function validPackageDir(s: string): boolean {
  return /^[A-Za-z0-9_./-]{1,120}$/.test(s) && !s.includes("..");
}

export interface CreateRequest {
  type: string;
  name: string;
  template?: string;
  sobject?: string;
  events?: string[];
  label?: string;
  mime?: string;
  /** Which package directory to create in; defaults to the project's first. */
  packageDir?: string;
}

export interface CreatePlan {
  /** Full sf argv - every element a literal or a validated value. */
  args: string[];
  /** Project-relative folder the component lands in. */
  outputDir: string;
  /** Project-relative path of the file to open afterwards; null when the type
   * produces no editable file (a zip static resource is a folder). */
  primary: string | null;
}

/** Turn a request into an exact sf invocation, or into the reason it cannot be
 * one. Pure, so the whole validation surface is testable without a CLI. */
export function buildCreatePlan(
  req: CreateRequest,
  pkgDirs: string[],
): { plan: CreatePlan } | { error: string } {
  const type = findType(req.type);
  if (!type) return { error: `unknown component type: ${String(req.type)}` };

  if (typeof req.name !== "string" || !validName(req.name, type.nameStyle)) {
    return {
      error:
        type.nameStyle === "camel"
          ? `"${String(req.name)}" is not a valid ${type.label} name - start with a lowercase letter, then letters, digits or underscores`
          : `"${String(req.name)}" is not a valid ${type.label} name - start with an uppercase letter, then letters, digits or underscores`,
    };
  }

  const pkg = req.packageDir ?? pkgDirs[0];
  if (!pkg || !validPackageDir(pkg)) {
    return { error: `unusable package directory: ${String(pkg)}` };
  }
  if (req.packageDir && !pkgDirs.includes(req.packageDir)) {
    return { error: `"${req.packageDir}" is not a package directory of this project` };
  }

  let template = "";
  if (type.templates.length > 0) {
    template = typeof req.template === "string" && req.template ? req.template : type.templates[0];
    if (!type.templates.includes(template)) {
      return { error: `unknown template for ${type.label}: ${template}` };
    }
  } else if (req.template) {
    return { error: `${type.label} takes no template` };
  }

  const outputDir = `${pkg}/main/default/${type.dir}`;
  const args = [...type.command, "--name", req.name, "--output-dir", outputDir];
  if (template) args.push("--template", template);

  if (type.needs.includes("sobject")) {
    const s = typeof req.sobject === "string" ? req.sobject.trim() : "";
    if (!s) return { error: "an object API name is required for a trigger" };
    if (!validSobject(s)) {
      return { error: `"${s}" is not a valid object API name` };
    }
    args.push("--sobject", s);
  }

  if (type.needs.includes("events")) {
    const events = Array.isArray(req.events) ? req.events : [];
    if (events.length === 0) return { error: "pick at least one trigger event" };
    for (const e of events) {
      if (!(TRIGGER_EVENTS as readonly string[]).includes(e)) {
        return { error: `unknown trigger event: ${String(e)}` };
      }
      args.push("--event", e);
    }
  }

  if (type.needs.includes("label")) {
    const l = typeof req.label === "string" ? req.label.trim() : "";
    if (!l) return { error: `a label is required for a ${type.label}` };
    if (!validLabel(l)) {
      return {
        error: "a label may contain letters, digits, spaces and ( ) . _ - only",
      };
    }
    args.push("--label", l);
  }

  if (type.needs.includes("mime")) {
    const m = typeof req.mime === "string" && req.mime ? req.mime : STATIC_RESOURCE_TYPES[0];
    if (!(STATIC_RESOURCE_TYPES as readonly string[]).includes(m)) {
      return { error: `unsupported content type: ${m}` };
    }
    args.push("--type", m);
  }

  args.push("--json");

  // The mime is resolved above when the type needs one; primaryFile has to see
  // the SAME value, because for a static resource it decides the extension.
  const mimeUsed = type.needs.includes("mime")
    ? ((typeof req.mime === "string" && req.mime ? req.mime : STATIC_RESOURCE_TYPES[0]) as string)
    : "";
  const rel = type.primaryFile(req.name, template, mimeUsed);

  return {
    plan: {
      args,
      outputDir,
      primary: rel ? `${outputDir}/${rel}` : null,
    },
  };
}

/** Quote the arguments that can legitimately contain a space.
 *
 * Only the values already proven free of shell metacharacters get here, so
 * this is purely about word-splitting: "before insert" has to survive as one
 * argument, and so does an output directory under a package folder someone
 * named with a space. */
function shellSafe(args: string[]): string[] {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
}

export interface CreateResult {
  ok: boolean;
  error?: string;
  /** Project-relative paths sf reported creating. */
  created: string[];
  /** Project-relative path worth opening in the editor. */
  primary?: string;
}

/** Run the plan. Refuses to write over anything that already exists, because
 * a template is a skeleton and re-scaffolding over real work would be silent
 * data loss - sf itself errors on some types and not others, so the check is
 * here where it is uniform. */
export async function createMetadata(
  root: string,
  req: CreateRequest,
  timeoutMs = 120_000,
): Promise<CreateResult> {
  const built = buildCreatePlan(req, await packageDirs(root));
  if ("error" in built) return { ok: false, error: built.error, created: [] };
  const { plan } = built;

  const type = findType(req.type)!;

  // Duplicate detection reads the target directory rather than reasoning
  // backwards from the primary file. It has to: a component is sometimes a
  // file (Foo.cls), sometimes a folder (an LWC bundle, a zip static resource),
  // and sometimes several files sharing a stem - and for a zip resource there
  // is no primary file to test at all. One rule covers every case: nothing in
  // the folder may BE the name or start with the name and a dot.
  const clash = await existingEntry(root, plan.outputDir, req.name);
  if (clash) {
    return {
      ok: false,
      error: `${type.label} "${req.name}" already exists in ${plan.outputDir} (${clash}) - pick another name`,
      created: [],
    };
  }

  const template = req.template ?? type.templates[0] ?? "";
  const mimeUsed =
    typeof req.mime === "string" && req.mime ? req.mime : (STATIC_RESOURCE_TYPES[0] as string);

  // FAST PATH: the same @salesforce/templates library the CLI wraps, in
  // process. A template is pure local scaffolding - no org, no network - so
  // every second of `sf` startup was waste: measured 4-6s through the CLI
  // against 0.01-0.03s here, for byte-identical output. The CLI stays as the
  // fallback, so a library that will not load costs the old speed, not the
  // feature.
  const viaLib = await createViaTemplates(root, type, plan, {
    name: req.name,
    template,
    mime: mimeUsed,
    outputDir: plan.outputDir,
    sobject: typeof req.sobject === "string" ? req.sobject.trim() : "",
    events: Array.isArray(req.events) ? req.events : [],
    label: typeof req.label === "string" ? req.label.trim() : "",
  });
  if (viaLib) return viaLib;

  const { stdout, stderr, ok } = await runSf(shellSafe(plan.args), root, timeoutMs);
  const parsed = parseSfJson(stdout);
  const result = parsed?.result ?? parsed;

  if (!ok || parsed?.status === 1) {
    const msg =
      (typeof parsed?.message === "string" && parsed.message) ||
      (typeof parsed?.name === "string" && parsed.name) ||
      (stderr || stdout).slice(-600) ||
      "sf template generate failed";
    return { ok: false, error: String(msg), created: [] };
  }

  // sf reports absolute paths; the app speaks project-relative throughout.
  const raw: unknown = result?.created ?? result?.files ?? [];
  const created = (Array.isArray(raw) ? raw : [])
    .map((f: unknown) =>
      typeof f === "string" ? f : ((f as { filePath?: string })?.filePath ?? ""),
    )
    .filter((f: string) => f.length > 0)
    .map((f: string) => {
      const rel = path.isAbsolute(f) ? path.relative(root, f) : f;
      return rel.replace(/\\/g, "/");
    });

  // Trust the file on disk over sf's reporting for what to open: the shape of
  // `created` differs between template commands, and an open that misses is a
  // worse ending than no open at all. A null plan.primary is not a failure -
  // it means this type has nothing to open.
  let primary: string | undefined;
  if (plan.primary) {
    primary = (await fs.stat(path.join(root, plan.primary)).catch(() => null))
      ? plan.primary
      : created.find((f) => f.endsWith(path.basename(plan.primary!)));
  }

  const fallback = plan.primary ? [plan.primary] : [plan.outputDir + "/" + req.name];
  return { ok: true, created: created.length > 0 ? created : fallback, primary };
}

/** Generate through @salesforce/templates, or null to fall back to the CLI.
 *
 * Returns null - never an error - on any problem: the dependency may be absent
 * in a trimmed install, a generator's option keys may change, and neither
 * should turn "create a class" into a failure when the CLI can still do it. */
async function createViaTemplates(
  root: string,
  type: CreateType,
  plan: CreatePlan,
  args: {
    name: string;
    template: string;
    mime: string;
    outputDir: string;
    sobject: string;
    events: string[];
    label: string;
  },
): Promise<CreateResult | null> {
  try {
    const mod = await import("@salesforce/templates");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kinds = (mod as any).TemplateType;
    const kind = kinds?.[type.tplType];
    if (kind === undefined) return null;

    // Some generators do not create their own output directory (a Visualforce
    // page does not), and the failure is an ENOENT deep inside the library.
    await fs.mkdir(path.join(root, plan.outputDir), { recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = (mod as any).TemplateService.getInstance(root);
    const res = await svc.create(kind, type.tplOpts(args));

    const raw: unknown = res?.created ?? [];
    const created = (Array.isArray(raw) ? raw : [])
      .filter((f: unknown): f is string => typeof f === "string" && f.length > 0)
      .map((f: string) => {
        const rel = path.isAbsolute(f) ? path.relative(root, f) : f;
        return rel.split(path.sep).join("/");
      });
    if (created.length === 0) return null;

    const primary = (await fs.stat(path.join(root, plan.primary ?? "")).catch(() => null))
      ? (plan.primary ?? undefined)
      : plan.primary
        ? created.find((f) => f.endsWith(path.basename(plan.primary!)))
        : undefined;

    return { ok: true, created, primary };
  } catch {
    return null;
  }
}

/** The existing entry in `outputDir` that would collide with `name`, or null.
 * Matches the name exactly (a folder) or the name followed by a dot (any of
 * the files that share a component's stem). */
async function existingEntry(
  root: string,
  outputDir: string,
  name: string,
): Promise<string | null> {
  const names = await fs.readdir(path.join(root, outputDir)).catch(() => [] as string[]);
  return names.find((n) => n === name || n.startsWith(name + ".")) ?? null;
}
