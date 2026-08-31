import { STATIC_RESOURCE_TYPES, TRIGGER_EVENTS, findType } from "@/lib/create/catalogue";

/** Turning a request into an exact command, or into the reason it cannot be one.
 *
 * This is the whole security surface of creation: it decides what argv reaches
 * a shell. Kept in its own module so that surface stays small and obvious, and
 * so the tests exercising it never touch the filesystem.
 *
 * Every validator here exists because runSf reaches a shell on Windows. The
 * rule throughout: a value either matches a charset with no shell metacharacter
 * in it at all, or it is not a value. Quoting is belt to those braces rather
 * than the only defence - `%` alone is enough to make cmd.exe interpolate, and
 * no amount of quoting saves you from it. */

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
