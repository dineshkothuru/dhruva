import { describe, expect, it } from "vitest";
import { deployablePath } from "@/lib/org/deployFile";

/** The editor's push-to-org is the only write-to-org path outside a gated
 * workflow, so its input gate gets tested directly.
 *
 * The confirmation-matching rule (the server refuses a deploy whose confirmOrg
 * does not equal the project's current org) lives in the route and is covered
 * by the route's own guards; what is testable purely is the path gate below. */

describe("deployablePath", () => {
  it("accepts real source paths", () => {
    for (const p of [
      "force-app/main/default/classes/AccountService.cls",
      "force-app/main/default/lwc/orderList/orderList.js",
      "packages/core/main/default/triggers/AccountTrigger.trigger",
      "force-app/main/default/objects/Account/fields/Region__c.field-meta.xml",
    ]) {
      expect(deployablePath(p), p).toBe(true);
    }
  });

  it("rejects every shell metacharacter", () => {
    // runSf reaches a shell on Windows and this path is user-chosen. It is a
    // rejection rather than an escape because `%` alone makes cmd.exe
    // interpolate regardless of quoting.
    for (const p of [
      'a";calc;"',
      "a&calc",
      "a|b",
      "a`id`",
      "a$(id)",
      "a%PATH%",
      "a;rm -rf /",
      "a>b",
      "a<b",
      "a\nb",
      "a\rb",
      "a\tb",
      "a'b",
      "a^b",
    ]) {
      expect(deployablePath(p), p).toBe(false);
    }
  });

  it("rejects wildcards, so one file cannot become the whole tree", () => {
    // --source-dir with a glob would deploy far more than the user confirmed.
    expect(deployablePath("force-app/**")).toBe(false);
    expect(deployablePath("force-app/main/default/classes/*.cls")).toBe(false);
    expect(deployablePath("force-app/main/default/classes/A?.cls")).toBe(false);
  });

  it("rejects an empty path and an absurdly long one", () => {
    expect(deployablePath("")).toBe(false);
    expect(deployablePath("a/".repeat(300) + "b.cls")).toBe(false);
  });

  it("allows spaces, because real component names have them", () => {
    // A layout is genuinely named "Account-Account %28Marketing%29 Layout" -
    // but the percent form is rejected above, so this only covers the space.
    expect(deployablePath("force-app/main/default/layouts/Account Layout.layout-meta.xml")).toBe(
      true,
    );
  });
});
