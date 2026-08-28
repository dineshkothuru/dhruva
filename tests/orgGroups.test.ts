import { describe, expect, it } from "vitest";
import { GROUP_ORDER, groupFor, groupTypes } from "@/lib/orgGroups";
import type { MetaType } from "@/lib/orgMetadata";

/** describeMetadata returns three hundred-odd type names in one alphabetical
 * run. Grouping is what makes that browsable, so the thing worth testing is
 * that the types a Salesforce developer actually opens land where they would
 * look for them - and that a type nobody has seen yet still lands somewhere. */

function t(name: string, dir = ""): MetaType {
  return { name, directoryName: dir, inFolder: false, children: [] };
}

describe("where a type belongs", () => {
  it("puts the everyday types where a developer would look", () => {
    expect(groupFor("ApexClass")).toBe("Apex");
    expect(groupFor("ApexTrigger")).toBe("Apex");
    expect(groupFor("LightningComponentBundle")).toBe("Lightning & UI");
    expect(groupFor("AuraDefinitionBundle")).toBe("Lightning & UI");
    expect(groupFor("CustomObject")).toBe("Data Model");
    expect(groupFor("CustomField")).toBe("Data Model");
    expect(groupFor("Flow")).toBe("Automation");
    expect(groupFor("Profile")).toBe("Security & Access");
    expect(groupFor("PermissionSet")).toBe("Security & Access");
    expect(groupFor("Report")).toBe("Reporting");
    expect(groupFor("NamedCredential")).toBe("Integration");
    expect(groupFor("Network")).toBe("Experience Cloud");
    expect(groupFor("StaticResource")).toBe("Content");
  });

  // The folder type has to sit with the content it holds, or Reports and their
  // folders end up in different parts of the tree.
  it("keeps folder types with their content", () => {
    expect(groupFor("ReportFolder")).toBe(groupFor("Report"));
    expect(groupFor("DashboardFolder")).toBe(groupFor("Dashboard"));
    expect(groupFor("EmailFolder")).toBe(groupFor("EmailTemplate"));
    expect(groupFor("DocumentFolder")).toBe(groupFor("Document"));
  });

  it("sends every *Settings type to Settings", () => {
    expect(groupFor("AccountSettings")).toBe("Settings");
    expect(groupFor("OrgPreferenceSettings")).toBe("Settings");
    expect(groupFor("SomeFutureSettings")).toBe("Settings");
  });

  // The rules exist so next release's type names land somewhere sensible
  // instead of all falling into Other.
  it("routes unknown names by rule rather than dropping them in Other", () => {
    expect(groupFor("ApexSomethingNew")).toBe("Apex");
    expect(groupFor("LightningFutureThing")).toBe("Lightning & UI");
    expect(groupFor("WorkflowFutureThing")).toBe("Automation");
    expect(groupFor("WaveSomething")).toBe("Reporting");
  });

  it("still has a home for a name no rule matches", () => {
    expect(groupFor("Zzzyzx")).toBe("Other");
    expect(GROUP_ORDER).toContain(groupFor("Zzzyzx"));
  });
});

describe("building the grouped tree", () => {
  const types = [
    t("ApexClass", "classes"),
    t("CustomObject", "objects"),
    t("ApexTrigger", "triggers"),
    t("Zzzyzx"),
    t("AccountSettings"),
  ];

  it("loses no type on the way in", () => {
    const groups = groupTypes(types);
    const flat = groups.flatMap((g) => g.types.map((x) => x.name)).sort();
    expect(flat).toEqual(types.map((x) => x.name).sort());
  });

  it("orders groups deliberately, not alphabetically", () => {
    const names = groupTypes(types).map((g) => g.name);
    const expected = GROUP_ORDER.filter((g) => names.includes(g));
    expect(names).toEqual(expected);
    // Apex before Other regardless of alphabet
    expect(names.indexOf("Apex")).toBeLessThan(names.indexOf("Other"));
  });

  // An org with no Experience Cloud should not show an empty folder for it.
  it("drops groups nothing landed in", () => {
    const names = groupTypes([t("ApexClass")]).map((g) => g.name);
    expect(names).toEqual(["Apex"]);
  });

  it("sorts types within a group", () => {
    const apex = groupTypes(types).find((g) => g.name === "Apex");
    expect(apex?.types.map((x) => x.name)).toEqual(["ApexClass", "ApexTrigger"]);
  });

  it("handles an org that listed nothing", () => {
    expect(groupTypes([])).toEqual([]);
  });
});
