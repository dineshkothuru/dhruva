import { describe, expect, it } from "vitest";
import {
  auraFileName,
  isQueryableName,
  rowsToFiles,
  soqlFor,
  toolingTargetFor,
} from "@/lib/org/toolingSource";

/** The fast path's whole risk is mapping: a wrong object or field name here
 * does not error, it silently falls back to the 15s retrieve, so the mapping is
 * pinned rather than trusted. */

describe("toolingTargetFor", () => {
  it("maps an Apex class", () => {
    const t = toolingTargetFor("main/default/classes/AccountService.cls")!;
    expect(t).toMatchObject({ kind: "apex", object: "ApexClass", field: "Body", name: "AccountService" });
  });

  it("maps a trigger, a page and a component", () => {
    expect(toolingTargetFor("main/default/triggers/AccountTrigger.trigger")).toMatchObject({
      object: "ApexTrigger",
      field: "Body",
      name: "AccountTrigger",
    });
    expect(toolingTargetFor("main/default/pages/AccountView.page")).toMatchObject({
      object: "ApexPage",
      field: "Markup",
    });
    expect(toolingTargetFor("main/default/components/Widget.component")).toMatchObject({
      object: "ApexComponent",
      field: "Markup",
    });
  });

  it("maps any file of an LWC bundle to the bundle itself", () => {
    // One query returns the whole bundle, so every file in it produces the
    // same target - that is what makes the second file free.
    for (const f of ["adminTools.html", "adminTools.js", "adminTools.js-meta.xml", "adminTools.css"]) {
      const t = toolingTargetFor(`main/default/lwc/adminTools/${f}`)!;
      expect(t, f).toMatchObject({
        kind: "lwc",
        object: "LightningComponentResource",
        name: "adminTools",
      });
    }
  });

  it("maps Aura files to the right DefType", () => {
    const cases: [string, string][] = [
      ["MyCmp.cmp", "COMPONENT"],
      ["MyCmp.app", "APPLICATION"],
      ["MyCmp.evt", "EVENT"],
      ["MyCmp.intf", "INTERFACE"],
      ["MyCmpController.js", "CONTROLLER"],
      ["MyCmpHelper.js", "HELPER"],
      ["MyCmpRenderer.js", "RENDERER"],
      ["MyCmp.css", "STYLE"],
      ["MyCmp.auradoc", "DOCUMENTATION"],
      ["MyCmp.design", "DESIGN"],
      ["MyCmp.svg", "SVG"],
    ];
    for (const [file, defType] of cases) {
      const t = toolingTargetFor(`main/default/aura/MyCmp/${file}`);
      expect(t?.defType, file).toBe(defType);
      expect(t?.object).toBe("AuraDefinition");
    }
  });

  it("tests the Aura suffix files BEFORE the bare .js cases", () => {
    // MyCmpController.js also ends in .js; if the order were wrong it would be
    // mapped as a plain resource and the compare would show the wrong file.
    expect(toolingTargetFor("main/default/aura/MyCmp/MyCmpController.js")?.defType).toBe(
      "CONTROLLER",
    );
    expect(toolingTargetFor("main/default/aura/MyCmp/MyCmpHelper.js")?.defType).toBe("HELPER");
  });

  it("falls back for the -meta.xml of a flat type", () => {
    // ApexClass metadata is not in the Tooling API, so this must return null
    // and let the retrieve path handle it rather than answer wrongly.
    expect(toolingTargetFor("main/default/classes/AccountService.cls-meta.xml")).toBeNull();
  });

  it("falls back for types the table does not cover", () => {
    for (const f of [
      "main/default/objects/Account/fields/X__c.field-meta.xml",
      "main/default/layouts/Account-Layout.layout-meta.xml",
      "main/default/flexipages/Home.flexipage-meta.xml",
      "main/default/permissionsets/Admin.permissionset-meta.xml",
      "main/default/staticresources/Logo.resource",
    ]) {
      expect(toolingTargetFor(f), f).toBeNull();
    }
  });

  it("does not mistake a class NAMED like a bundle dir", () => {
    expect(toolingTargetFor("main/default/classes/lwc.cls")).toMatchObject({ object: "ApexClass" });
  });

  it("accepts Windows separators", () => {
    expect(toolingTargetFor("main\\default\\classes\\A.cls")).toMatchObject({ name: "A" });
  });
});

describe("name safety", () => {
  it("accepts real API names", () => {
    expect(isQueryableName("AccountService")).toBe(true);
    expect(isQueryableName("adminTools")).toBe(true);
  });

  it("rejects anything that could alter the SOQL", () => {
    // These reach a query string, so a quote or a comment marker matters.
    for (const bad of ["A'--", "A' OR Name!='", "A;DROP", "A B", "", "1A", "A\n"]) {
      expect(isQueryableName(bad), bad).toBe(false);
    }
  });

  it("refuses to build SOQL for an unsafe name", () => {
    const t = toolingTargetFor("main/default/classes/A.cls")!;
    expect(soqlFor({ ...t, name: "A' OR Name != '" })).toBeNull();
  });
});

describe("soqlFor", () => {
  it("scopes an Apex query to the unmanaged namespace", () => {
    // Without this a managed-package class of the same name can win, and the
    // compare then shows source the user cannot edit.
    const q = soqlFor(toolingTargetFor("main/default/classes/A.cls")!)!;
    expect(q).toContain("FROM ApexClass");
    expect(q).toContain("Name = 'A'");
    expect(q).toContain("NamespacePrefix = null");
  });

  it("asks for FilePath on an LWC query so rows can be placed", () => {
    const q = soqlFor(toolingTargetFor("main/default/lwc/x/x.js")!)!;
    expect(q).toContain("FilePath");
    expect(q).toContain("LightningComponentBundle.DeveloperName = 'x'");
  });

  it("pins an Aura query to one DefType", () => {
    const q = soqlFor(toolingTargetFor("main/default/aura/MyCmp/MyCmpHelper.js")!)!;
    expect(q).toContain("DefType = 'HELPER'");
  });
});

describe("rowsToFiles", () => {
  it("places an Apex body at its own path", () => {
    const t = toolingTargetFor("main/default/classes/A.cls")!;
    const files = rowsToFiles(t, "force-app", [{ Body: "public class A {}" }]);
    expect([...files.keys()]).toEqual(["force-app/main/default/classes/A.cls"]);
  });

  it("re-roots LWC FilePaths onto the project's own directory", () => {
    // The org returns "lwc/<bundle>/<file>", which is NOT where the file lives
    // in a project using main/default - only the file name is usable.
    const t = toolingTargetFor("main/default/lwc/adminTools/adminTools.html")!;
    const files = rowsToFiles(t, "force-app", [
      { FilePath: "lwc/adminTools/adminTools.html", Source: "<template></template>" },
      { FilePath: "lwc/adminTools/adminTools.js", Source: "export default {}" },
      { FilePath: "lwc/adminTools/adminTools.js-meta.xml", Source: "<xml/>" },
    ]);
    expect([...files.keys()].sort()).toEqual([
      "force-app/main/default/lwc/adminTools/adminTools.html",
      "force-app/main/default/lwc/adminTools/adminTools.js",
      "force-app/main/default/lwc/adminTools/adminTools.js-meta.xml",
    ]);
    expect(files.get("force-app/main/default/lwc/adminTools/adminTools.html")).toContain(
      "<template>",
    );
  });

  it("names Aura rows from their DefType", () => {
    const t = toolingTargetFor("main/default/aura/MyCmp/MyCmp.cmp")!;
    const files = rowsToFiles(t, "force-app", [{ DefType: "COMPONENT", Source: "<aura:component/>" }]);
    expect([...files.keys()]).toEqual(["force-app/main/default/aura/MyCmp/MyCmp.cmp"]);
  });

  it("skips rows with no usable source instead of inventing empty files", () => {
    const t = toolingTargetFor("main/default/lwc/x/x.js")!;
    expect(rowsToFiles(t, "force-app", [{ FilePath: "lwc/x/x.js", Source: null }]).size).toBe(0);
    expect(rowsToFiles(t, "force-app", [{ Source: "orphan" }]).size).toBe(0);
  });

  it("round-trips every Aura DefType it claims to support", () => {
    for (const d of [
      "COMPONENT",
      "APPLICATION",
      "EVENT",
      "INTERFACE",
      "CONTROLLER",
      "HELPER",
      "RENDERER",
      "STYLE",
      "DOCUMENTATION",
      "DESIGN",
      "SVG",
      "TOKENS",
    ]) {
      const file = auraFileName("MyCmp", d)!;
      expect(file, d).toBeTruthy();
      expect(toolingTargetFor(`main/default/aura/MyCmp/${file}`)?.defType, file).toBe(d);
    }
  });
});
