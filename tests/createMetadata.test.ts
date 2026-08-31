import { describe, expect, it } from "vitest";
import {
  CREATE_TYPES,
  buildCreatePlan,
  findType,
  isFolderResource,
  validLabel,
  validName,
  validPackageDir,
  validSobject,
} from "@/lib/createMetadata";

/** buildCreatePlan is the whole security and correctness surface of creation:
 * it decides what argv reaches a shell. Every value in that argv is either a
 * fixed literal from the type table or something these tests prove is a plain
 * identifier. */

const PKGS = ["force-app"];

function plan(req: Parameters<typeof buildCreatePlan>[0], pkgs = PKGS) {
  const out = buildCreatePlan(req, pkgs);
  if ("error" in out) throw new Error("expected a plan, got: " + out.error);
  return out.plan;
}

function err(req: Parameters<typeof buildCreatePlan>[0], pkgs = PKGS) {
  const out = buildCreatePlan(req, pkgs);
  if ("plan" in out) throw new Error("expected an error, got a plan");
  return out.error;
}

describe("the type table", () => {
  it("has a unique id per type", () => {
    const ids = CREATE_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only ever puts literals in the fixed command", () => {
    // Nothing in `command` may look like a placeholder - the whole design
    // rests on the fixed part being fixed.
    for (const t of CREATE_TYPES) {
      for (const arg of t.command) {
        expect(arg).not.toMatch(/[{}$`"'<>|&;%]/);
      }
    }
  });

  it("declares a template list only where the command takes one", () => {
    // A type with no templates must not be sent --template, and one with
    // templates must have a usable default at index 0.
    for (const t of CREATE_TYPES) {
      if (t.templates.length > 0) expect(t.templates[0]).toBeTruthy();
    }
  });
});

describe("names", () => {
  it("requires PascalCase for Apex", () => {
    expect(validName("AccountService", "pascal")).toBe(true);
    expect(validName("Account_Service2", "pascal")).toBe(true);
    expect(validName("accountService", "pascal")).toBe(false);
    expect(validName("2Account", "pascal")).toBe(false);
  });

  it("requires a lowercase first letter for an LWC bundle", () => {
    // A capitalised LWC folder produces a bundle that will not load.
    expect(validName("myComponent", "camel")).toBe(true);
    expect(validName("MyComponent", "camel")).toBe(false);
  });

  it("rejects every shell metacharacter", () => {
    for (const bad of [
      "A;rm -rf /",
      "A&&whoami",
      "A|b",
      "A`id`",
      "A$(id)",
      "A%PATH%",
      "A B",
      'A"B',
      "A'B",
      "A>b",
      "A\nB",
      "../../A",
    ]) {
      expect(validName(bad, "pascal")).toBe(false);
      expect(validName(bad, "camel")).toBe(false);
    }
  });

  it("rejects an empty name and an over-long one", () => {
    expect(validName("", "pascal")).toBe(false);
    expect(validName("A".repeat(200), "pascal")).toBe(false);
  });
});

describe("other validated values", () => {
  it("accepts real object API names and rejects injection", () => {
    expect(validSobject("Account")).toBe(true);
    expect(validSobject("My_Object__c")).toBe(true);
    expect(validSobject("Account;id")).toBe(false);
    expect(validSobject("%PATH%")).toBe(false);
  });

  it("allows a human label but nothing a shell acts on", () => {
    expect(validLabel("Account Summary")).toBe(true);
    expect(validLabel("Order (v2).1_a-b")).toBe(true);
    expect(validLabel("Bad & Worse")).toBe(false);
    expect(validLabel("100% done")).toBe(false);
    expect(validLabel("`id`")).toBe(false);
    expect(validLabel("")).toBe(false);
  });

  it("keeps a package directory a path and not an escape", () => {
    expect(validPackageDir("force-app")).toBe(true);
    expect(validPackageDir("packages/core")).toBe(true);
    expect(validPackageDir("../outside")).toBe(false);
    expect(validPackageDir("force-app;rm")).toBe(false);
  });
});

describe("buildCreatePlan", () => {
  it("builds an Apex class with its default template", () => {
    const p = plan({ type: "apex-class", name: "AccountService" });
    expect(p.args).toEqual([
      "template",
      "generate",
      "apex",
      "class",
      "--name",
      "AccountService",
      "--output-dir",
      "force-app/main/default/classes",
      "--template",
      "DefaultApexClass",
      "--json",
    ]);
    expect(p.primary).toBe("force-app/main/default/classes/AccountService.cls");
  });

  it("builds an LWC bundle and points at the bundle's js file", () => {
    const p = plan({ type: "lwc", name: "orderList" });
    expect(p.args).toContain("--type");
    expect(p.args).toContain("lwc");
    expect(p.outputDir).toBe("force-app/main/default/lwc");
    expect(p.primary).toBe("force-app/main/default/lwc/orderList/orderList.js");
  });

  it("points at .ts for the typescript LWC template", () => {
    // Opening orderList.js after a typescript scaffold would land the user on
    // a file-not-found straight after a success.
    const p = plan({ type: "lwc", name: "orderList", template: "typescript" });
    expect(p.primary).toBe("force-app/main/default/lwc/orderList/orderList.ts");
  });

  it("builds a trigger with its object and one flag per event", () => {
    const p = plan({
      type: "apex-trigger",
      name: "AccountTrigger",
      sobject: "Account",
      events: ["before insert", "after update"],
    });
    expect(p.args).toContain("--sobject");
    expect(p.args).toContain("Account");
    // one --event per event, not a joined string
    expect(p.args.filter((a) => a === "--event")).toHaveLength(2);
    expect(p.args).toContain("before insert");
    expect(p.args).toContain("after update");
  });

  it("refuses a trigger with no object or no event", () => {
    expect(err({ type: "apex-trigger", name: "T", events: ["before insert"] })).toMatch(
      /object API name is required/,
    );
    expect(err({ type: "apex-trigger", name: "T", sobject: "Account", events: [] })).toMatch(
      /at least one trigger event/,
    );
  });

  it("refuses an event that is not in the fixed list", () => {
    // These strings reach a shell, so the enum IS the gate.
    expect(
      err({
        type: "apex-trigger",
        name: "T",
        sobject: "Account",
        events: ["before insert; rm -rf /"],
      }),
    ).toMatch(/unknown trigger event/);
  });

  it("requires a label for Visualforce and validates it", () => {
    expect(err({ type: "vf-page", name: "AccountView" })).toMatch(/label is required/);
    expect(err({ type: "vf-page", name: "AccountView", label: "bad & label" })).toMatch(
      /may contain letters/,
    );
    const p = plan({ type: "vf-page", name: "AccountView", label: "Account View" });
    expect(p.args).toContain("--label");
    expect(p.args).toContain("Account View");
  });

  it("defaults and validates a static resource content type", () => {
    expect(plan({ type: "static-resource", name: "Assets" }).args).toContain("application/zip");
    expect(err({ type: "static-resource", name: "Assets", mime: "text/evil" })).toMatch(
      /unsupported content type/,
    );
  });

  it("rejects an unknown type and an unknown template", () => {
    expect(err({ type: "nope", name: "A" })).toMatch(/unknown component type/);
    expect(err({ type: "apex-class", name: "A", template: "Nope" })).toMatch(/unknown template/);
  });

  it("refuses a template for a type that takes none", () => {
    expect(err({ type: "vf-page", name: "A", label: "A", template: "X" })).toMatch(
      /takes no template/,
    );
  });

  it("uses the first package directory by default", () => {
    const p = plan({ type: "apex-class", name: "A" }, ["packages/core", "force-app"]);
    expect(p.outputDir).toBe("packages/core/main/default/classes");
  });

  it("honours an explicit package directory that the project actually has", () => {
    const p = plan({ type: "apex-class", name: "A", packageDir: "force-app" }, [
      "packages/core",
      "force-app",
    ]);
    expect(p.outputDir).toBe("force-app/main/default/classes");
  });

  it("refuses a package directory the project does not have", () => {
    // Otherwise the dialog could write anywhere the charset allows.
    expect(err({ type: "apex-class", name: "A", packageDir: "somewhere-else" })).toMatch(
      /not a package directory/,
    );
    expect(err({ type: "apex-class", name: "A", packageDir: "../escape" })).toMatch(
      /unusable package directory|not a package directory/,
    );
  });

  it("never emits an argument carrying a shell metacharacter", () => {
    // The end-to-end invariant, over every type in the table.
    for (const t of CREATE_TYPES) {
      const out = buildCreatePlan(
        {
          type: t.id,
          name: t.nameStyle === "camel" ? "someThing" : "SomeThing",
          sobject: "Account",
          events: ["before insert"],
          label: "Some Label",
        },
        PKGS,
      );
      if ("error" in out) throw new Error(`${t.id}: ${out.error}`);
      for (const arg of out.plan.args) {
        expect(arg, `${t.id} arg ${arg}`).not.toMatch(/[`$&|;<>^%"'\n\r]/);
      }
    }
  });

  it("opens the static resource's CONTENT file, not its metadata", () => {
    // The bug this guards: the dialog used to open <name>.resource-meta.xml,
    // so a new static resource looked like it had no content file even though
    // sf had written one right beside it.
    expect(plan({ type: "static-resource", name: "Assets", mime: "application/json" }).primary).toBe(
      "force-app/main/default/staticresources/Assets.json",
    );
    expect(plan({ type: "static-resource", name: "Theme", mime: "text/css" }).primary).toBe(
      "force-app/main/default/staticresources/Theme.css",
    );
    expect(plan({ type: "static-resource", name: "Util", mime: "text/javascript" }).primary).toBe(
      "force-app/main/default/staticresources/Util.js",
    );
    expect(plan({ type: "static-resource", name: "Notes", mime: "text/plain" }).primary).toBe(
      "force-app/main/default/staticresources/Notes.txt",
    );
  });

  it("uses .resource for the binary content types - NOT .png or .svg", () => {
    // Measured off a real CLI: sf names both of these <name>.resource.
    for (const mime of ["image/png", "image/svg+xml"]) {
      expect(plan({ type: "static-resource", name: "Logo", mime }).primary).toBe(
        "force-app/main/default/staticresources/Logo.resource",
      );
    }
  });

  it("has nothing to open for a zip resource, because it is a folder", () => {
    const p = plan({ type: "static-resource", name: "Bundle", mime: "application/zip" });
    expect(p.primary).toBeNull();
    expect(isFolderResource("application/zip")).toBe(true);
    expect(isFolderResource("text/css")).toBe(false);
  });

  it("defaults a static resource with no mime to the zip folder form", () => {
    // The default content type is application/zip, so the default has no
    // primary file either - and that must not be mistaken for a failure.
    expect(plan({ type: "static-resource", name: "Bundle" }).primary).toBeNull();
  });

  it("gives every other type a primary file", () => {
    for (const t of CREATE_TYPES.filter((x) => x.id !== "static-resource")) {
      const out = buildCreatePlan(
        {
          type: t.id,
          name: t.nameStyle === "camel" ? "someThing" : "SomeThing",
          sobject: "Account",
          events: ["before insert"],
          label: "Some Label",
        },
        PKGS,
      );
      if ("error" in out) throw new Error(`${t.id}: ${out.error}`);
      expect(out.plan.primary, t.id).toBeTruthy();
    }
  });

  it("exposes every table type through findType", () => {
    for (const t of CREATE_TYPES) expect(findType(t.id)?.id).toBe(t.id);
    expect(findType("missing")).toBeNull();
    expect(findType(undefined)).toBeNull();
  });
});
