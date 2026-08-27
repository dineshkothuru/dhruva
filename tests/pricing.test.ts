import { describe, expect, it } from "vitest";
import { estimateTokens, estimateUsage, formatUsage } from "@/lib/pricing";

/** Cost numbers are shown to the user on every step and run. They are
 * estimates, but they must never be wildly wrong or negative. */
describe("pricing", () => {
  it("estimates tokens at roughly 4 characters each", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(0);
  });

  it("charges output more than input for the same volume", () => {
    const text = "x".repeat(4000);
    const inHeavy = estimateUsage("claude", "claude-sonnet-5", text, "");
    const outHeavy = estimateUsage("claude", "claude-sonnet-5", "", text);
    expect(outHeavy.costUsd).toBeGreaterThan(inHeavy.costUsd);
  });

  it("prices an opus-tier model above a haiku-tier one", () => {
    const t = "y".repeat(4000);
    expect(estimateUsage("claude", "claude-opus-5", t, t).costUsd)
      .toBeGreaterThan(estimateUsage("claude", "claude-haiku-4-5", t, t).costUsd);
  });

  it("falls back to an agent default when the model is unknown", () => {
    const u = estimateUsage("copilot", undefined, "hello world", "hi");
    expect(u.costUsd).toBeGreaterThan(0);
    expect(u.estimated).toBe(true);
  });

  it("never returns negative or NaN cost", () => {
    const u = estimateUsage("nonexistent-agent", "nonexistent-model", "", "");
    expect(u.costUsd).toBe(0);
    expect(Number.isNaN(u.costUsd)).toBe(false);
  });

  it("formats sub-cent costs with four decimals and a tilde when estimated", () => {
    const s = formatUsage({ inTokens: 100, outTokens: 50, costUsd: 0.0012, estimated: true });
    expect(s).toContain("~");
    expect(s).toContain("$0.0012");
    expect(s).toContain("est. at API rates");
  });

  it("drops the tilde when the vendor reported exact usage", () => {
    const s = formatUsage({ inTokens: 1000, outTokens: 500, costUsd: 1.5, estimated: false });
    expect(s.startsWith("~")).toBe(false);
    expect(s).toContain("$1.50");
    expect(s).toContain("reported by the agent");
  });
});
