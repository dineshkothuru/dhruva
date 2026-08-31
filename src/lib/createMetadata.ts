import { promises as fs } from "node:fs";
import path from "node:path";
import { parseSfJson, runSf } from "@/lib/orgMetadata";
import { packageDirs } from "@/lib/orgCompare";
import {
  STATIC_RESOURCE_TYPES,
  findType,
  type CreateType,
} from "@/lib/create/catalogue";
import { buildCreatePlan, type CreatePlan, type CreateRequest } from "@/lib/create/plan";

// One entry point for creation, even though it is now three modules behind
// that door: the API route and the tests import from here.
export {
  CREATE_TYPES,
  STATIC_RESOURCE_TYPES,
  TRIGGER_EVENTS,
  findType,
  isFolderResource,
  type CreateType,
  type ExtraField,
} from "@/lib/create/catalogue";
export {
  buildCreatePlan,
  validLabel,
  validName,
  validPackageDir,
  validSobject,
  type CreatePlan,
  type CreateRequest,
} from "@/lib/create/plan";

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
