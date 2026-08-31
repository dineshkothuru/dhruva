/** What Dhruva can scaffold, as one table.
 *
 * Split out of createMetadata.ts because the table is the bulk of it and has
 * nothing to do with how a component gets generated: every command, flag,
 * template list and option key here was read off a real CLI or the real
 * templates library, and it changes for entirely different reasons than the
 * execution code does. */


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
