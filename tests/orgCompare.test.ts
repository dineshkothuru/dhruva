import { describe, expect, it } from "vitest";
import {
  copyPlanFor,
  readRetrieveOutcome,
  sameStemPrefix,
  splitPackagePath,
} from "@/lib/orgCompare";

/** The org compare's correctness lives in three places, all of them here:
 * deciding which package directory a file belongs to, deciding what has to be
 * copied for sf to resolve the component, and reading sf's answer without
 * mistaking "the org does not have this" for "the two sides match". */

describe("splitPackagePath", () => {
  it("splits a path inside the default package directory", () => {
    expect(splitPackagePath("force-app/main/default/classes/A.cls", ["force-app"])).toEqual({
      pkg: "force-app",
      rest: "main/default/classes/A.cls",
    });
  });

  it("accepts backslashes - Windows paths arrive that way", () => {
    expect(
      splitPackagePath("force-app\\main\\default\\classes\\A.cls", ["force-app"]),
    ).toEqual({ pkg: "force-app", rest: "main/default/classes/A.cls" });
  });

  it("prefers the most specific package directory", () => {
    expect(
      splitPackagePath("force-app/extra/main/default/classes/A.cls", [
        "force-app",
        "force-app/extra",
      ]),
    ).toEqual({ pkg: "force-app/extra", rest: "main/default/classes/A.cls" });
  });

  it("handles a non-conventional package directory name", () => {
    expect(splitPackagePath("src/classes/A.cls", ["src"])).toEqual({
      pkg: "src",
      rest: "classes/A.cls",
    });
  });

  it("rejects a file outside every package directory", () => {
    expect(splitPackagePath("scripts/deploy.sh", ["force-app"])).toBeNull();
    expect(splitPackagePath("sfdx-project.json", ["force-app"])).toBeNull();
  });

  it("rejects the package directory itself - a directory is not a component", () => {
    expect(splitPackagePath("force-app", ["force-app"])).toBeNull();
  });

  it("does not match a directory that merely shares a prefix", () => {
    expect(splitPackagePath("force-app-old/classes/A.cls", ["force-app"])).toBeNull();
  });
});

describe("copyPlanFor", () => {
  it("copies a class as a file, so its siblings come with it", () => {
    expect(copyPlanFor("main/default/classes/AccountService.cls")).toEqual({
      kind: "file",
      target: "main/default/classes/AccountService.cls",
    });
  });

  it("copies an LWC as the whole bundle - a lone .js is not a component", () => {
    expect(copyPlanFor("main/default/lwc/adminTools/adminTools.js")).toEqual({
      kind: "dir",
      target: "main/default/lwc/adminTools",
    });
  });

  it("copies an Aura bundle as a directory", () => {
    expect(copyPlanFor("main/default/aura/MyCmp/MyCmp.cmp")).toEqual({
      kind: "dir",
      target: "main/default/aura/MyCmp",
    });
  });

  it("copies the object folder for a custom field", () => {
    expect(copyPlanFor("main/default/objects/Account/fields/Region__c.field-meta.xml")).toEqual({
      kind: "dir",
      target: "main/default/objects/Account",
    });
  });

  it("copies the Salesforce folder for a folder-based type", () => {
    expect(copyPlanFor("main/default/reports/Ops/Backlog.report-meta.xml")).toEqual({
      kind: "dir",
      target: "main/default/reports/Ops",
    });
  });

  it("treats a flat static resource as a file, not a bundle", () => {
    expect(copyPlanFor("main/default/staticresources/logo.resource-meta.xml")).toEqual({
      kind: "file",
      target: "main/default/staticresources/logo.resource-meta.xml",
    });
  });

  it("treats a foldered static resource as a bundle", () => {
    expect(copyPlanFor("main/default/staticresources/theme/app.css")).toEqual({
      kind: "dir",
      target: "main/default/staticresources/theme",
    });
  });

  it("is not fooled by a bundle name appearing deeper in the path", () => {
    // "objects" here is a component NAME, not a type folder, so the first
    // match wins and the whole thing is still one flat file.
    expect(copyPlanFor("main/default/classes/objects.cls")).toEqual({
      kind: "file",
      target: "main/default/classes/objects.cls",
    });
  });
});

describe("sameStemPrefix", () => {
  it("pairs a class with its metadata companion", () => {
    const stem = sameStemPrefix("AccountService.cls");
    expect("AccountService.cls-meta.xml".startsWith(stem)).toBe(true);
  });

  it("does not drag in a different class whose name shares a prefix", () => {
    const stem = sameStemPrefix("Account.cls");
    expect("AccountService.cls".startsWith(stem)).toBe(false);
  });

  it("survives a component name containing spaces and escapes", () => {
    expect(sameStemPrefix("Account-Account %28Marketing%29 Layout.layout-meta.xml")).toBe(
      "Account-Account %28Marketing%29 Layout.",
    );
  });
});

describe("readRetrieveOutcome", () => {
  const ok = (files: unknown[]) => JSON.stringify({ status: 0, result: { files } });

  it("reports success when the component came back", () => {
    const out = readRetrieveOutcome(
      ok([{ fullName: "A", type: "ApexClass", state: "Changed", filePath: "x" }]),
      true,
    );
    expect(out).toEqual({ ok: true, missing: false });
  });

  it("reports success for an unchanged component", () => {
    const out = readRetrieveOutcome(ok([{ state: "Unchanged" }]), true);
    expect(out.ok).toBe(true);
    expect(out.missing).toBe(false);
  });

  it("reports MISSING - not identical - when the org has no such component", () => {
    // The sandbox starts as a copy of the local file, so without this the two
    // sides come out byte-identical and the UI would claim "in sync".
    const out = readRetrieveOutcome(
      ok([
        {
          fullName: "ZzNew",
          type: "ApexClass",
          state: "Failed",
          error: "Entity of type 'ApexClass' named 'ZzNew' cannot be found",
          problemType: "Error",
        },
      ]),
      true,
    );
    expect(out).toEqual({ ok: true, missing: true });
  });

  it("surfaces a real failure as an error, not as missing", () => {
    const out = readRetrieveOutcome(
      ok([{ state: "Failed", error: "INVALID_SESSION_ID: Session expired or invalid" }]),
      false,
    );
    expect(out.ok).toBe(false);
    expect(out.missing).toBe(false);
    expect(out.error).toContain("INVALID_SESSION_ID");
  });

  it("keeps a partial bundle result as a success", () => {
    // One piece of a bundle failing must not lose the pieces that came back.
    const out = readRetrieveOutcome(
      ok([{ state: "Changed" }, { state: "Failed", error: "something odd" }]),
      true,
    );
    expect(out).toEqual({ ok: true, missing: false });
  });

  it("reads a top-level error message when there is no files array", () => {
    const out = readRetrieveOutcome(
      JSON.stringify({ status: 1, name: "NoOrgFound", message: "No authorization found" }),
      false,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("No authorization found");
  });

  it("treats a top-level not-found message as missing", () => {
    const out = readRetrieveOutcome(
      JSON.stringify({ status: 1, message: "No metadata found for the specified component" }),
      false,
    );
    expect(out).toEqual({ ok: true, missing: true });
  });

  it("names the empty-result case instead of shrugging", () => {
    // sf exits 0 with {"files": []} when it resolves no component at all -
    // the symptom of an inherited .forceignore. "no retrieve result" sent a
    // real debugging session the wrong way, so the message has to be specific.
    const out = readRetrieveOutcome(ok([]), true);
    expect(out.ok).toBe(false);
    expect(out.missing).toBe(false);
    expect(out.error).toMatch(/resolved no metadata component/);
  });

  it("never reports success on unparseable output", () => {
    const out = readRetrieveOutcome("sf crashed with no json at all", false);
    expect(out.ok).toBe(false);
    expect(out.missing).toBe(false);
  });

  it("survives sf's colorized output and warning prefix", () => {
    const noisy =
      "Warning: @salesforce/cli update available\n" +
      String.fromCharCode(27) +
      "[32m" +
      ok([{ state: "Changed" }]);
    expect(readRetrieveOutcome(noisy, true)).toEqual({ ok: true, missing: false });
  });
});
