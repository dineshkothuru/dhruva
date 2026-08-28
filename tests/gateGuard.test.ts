import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const ENGINE = path.resolve(__dirname, "../src/lib/workflows/engine.ts");

/** Two safety behaviours that a unit test cannot exercise directly - one lives
 * inside a spawn callback, the other inside the executor loop - but whose
 * absence caused real damage on run 8404e1ed-465 and run 029f2a49-5dd. These
 * hold the shape of the fix so it cannot be quietly undone.
 *
 * A source-text assertion is a weak test and is used here only because the
 * alternative is no test at all. The behaviour itself is covered end to end by
 * re-running the workflow. */
describe("a timed-out step actually stops", () => {
  it("the timeout handler settles the step instead of waiting for the kill to work", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const timer = src.slice(src.indexOf("const timer = setTimeout"));
    const body = timer.slice(0, timer.indexOf("}, timeoutMs);"));
    expect(body).toContain("taskkill");
    // the point of the fix: it does not depend on the kill succeeding
    expect(body).toContain("settle(false)");
  });

  it("has a single settle point that cannot fire twice", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    expect(src).toContain("let settled = false");
    expect(src).toMatch(/const settle = \(ok: boolean\) => \{\s*if \(settled\) return;/);
    // a late "close" must not append an exit line to an already-finished step
    expect(src).toMatch(/child\.on\("close"[\s\S]{0,200}if \(settled\) return;/);
  });
});

describe("auto-approve does not launder a failed review", () => {
  it("the gate consults the preceding review before auto-approving", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    expect(src).toMatch(/const auto = run\.autoGate === true && !blocked/);
  });

  it("treats an unparseable or missing verdict as nothing to hold back on", async () => {
    const src = await fs.readFile(ENGINE, "utf8");
    const fn = src.slice(src.indexOf("function blockedReviewBefore"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // no verdict found -> "" -> the gate behaves exactly as it did before
    expect(body).toContain("if (!verdict) return \"\";");
    expect(body).toMatch(/verdict === "APPROVED" \|\| verdict === "PASS"/);
    // only looks back as far as the previous gate
    expect(body).toContain('if (d.type === "gate") break;');
    // only a review-role step counts
    expect(body).toMatch(/d\.role !== "review"/);
  });
});
