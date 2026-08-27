import { describe, expect, it } from "vitest";
import { classifyChain, classifyIntake, matchCatalog } from "@/lib/intake";

/** Intake decides what a typed request becomes: a chat answer, one workflow,
 * or a multi-phase chain. Misclassification either wastes a full run or
 * silently drops the user into plain chat. */
describe("classifyIntake", () => {
  it("routes failure language to the bug-fix workflow", () => {
    const p = classifyIntake("the account trigger fails with a null pointer exception on bulk insert");
    expect(p?.workflow).toBe("bug-fix");
  });

  it("routes new requirements to feature development", () => {
    const p = classifyIntake("we need a new validation on the opportunity object for renewals");
    expect(p?.workflow).toBe("feature-dev");
  });

  it("lets design intent outrank feature wording", () => {
    const p = classifyIntake("design the solution architecture for a new renewals module");
    expect(p?.workflow).toBe("solution-design");
  });

  it("sends plain questions to chat, not a workflow", () => {
    expect(classifyIntake("how does the sharing model work on this object?")).toBeNull();
  });

  it("ignores text too short to be a delivery task", () => {
    expect(classifyIntake("fix the bug")).toBeNull();
  });
});

describe("classifyChain", () => {
  it("proposes design then implement for a two-phase request", () => {
    const c = classifyChain("Design and implement a lead scoring engine for our org");
    expect(c?.phases.map((p) => p.workflow)).toEqual(["solution-design", "implement-tdd"]);
  });

  it("accepts 'then' as the joining word", () => {
    expect(classifyChain("Please design the data model, then build the automation for renewals")).not.toBeNull();
  });

  it("does not chain a design-only request", () => {
    expect(classifyChain("Design the architecture for the renewal automation module")).toBeNull();
  });

  it("does not chain an implement-only request", () => {
    expect(classifyChain("Implement the renewal automation as described in the attached story")).toBeNull();
  });

  it("leaves bug reports to the single-workflow intake", () => {
    expect(classifyChain("The design page implementation breaks and fails with an exception when saving")).toBeNull();
  });
});

describe("matchCatalog", () => {
  const catalog = [
    { id: "bug-fix", title: "Bug fix" },
    { id: "solution-design", title: "Solution design" },
    { id: "lwc-visual-audit", title: "LWC visual audit", custom: true },
    { id: "data-migration", title: "Data migration", custom: true },
  ];

  it("suggests a custom workflow named in the request", () => {
    expect(matchCatalog("run the LWC visual audit on the account panel components", catalog)?.workflow)
      .toBe("lwc-visual-audit");
  });

  it("matches on title tokens, not just the exact phrase", () => {
    expect(matchCatalog("we need a data migration for the legacy contacts", catalog)?.workflow)
      .toBe("data-migration");
  });

  it("returns null when nothing in the catalog is referenced", () => {
    expect(matchCatalog("why is the account trigger slow on bulk loads", catalog)).toBeNull();
  });

  it("does not fire on short generic titles", () => {
    expect(matchCatalog("please fix the bug in the trigger", [{ id: "bug-fix", title: "Bug fix" }])).toBeNull();
  });

  it("is a no-op before the catalog has loaded", () => {
    expect(matchCatalog("run the LWC visual audit please", null)).toBeNull();
  });
});
