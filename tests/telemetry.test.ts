import { describe, expect, it } from "vitest";
import { durationBucket, sanitizeProps } from "@/lib/telemetry";

/** The allowlist IS the privacy contract. Dhruva runs inside customer
 * codebases, so these tests exist to fail loudly if a future change lets
 * project-identifying data through. */
describe("sanitizeProps", () => {
  it("keeps allowlisted properties", () => {
    expect(sanitizeProps({ agent: "claude", outcome: "done", step_count: 12 })).toEqual({
      agent: "claude",
      outcome: "done",
      step_count: 12,
    });
  });

  it("drops anything not on the allowlist", () => {
    const out = sanitizeProps({
      agent: "claude",
      project_name: "acme-corp",
      file_path: "force-app/main/default/classes/Billing.cls",
      prompt: "implement the billing rules",
      org_username: "admin@acme.com",
      error_message: "NullPointerException at line 42",
    } as never);
    expect(out).toEqual({ agent: "claude" });
  });

  it("passes a shipped workflow id through", () => {
    expect(sanitizeProps({ workflow_id: "solution-design" })).toEqual({
      workflow_id: "solution-design",
    });
  });

  it("never transmits a CUSTOM workflow id - only that one was used", () => {
    const out = sanitizeProps({ workflow_id: "acme-migration-audit" });
    expect(out.workflow_id).toBeUndefined();
    expect(out.workflow_custom).toBe(true);
  });

  it("drops undefined values instead of sending nulls", () => {
    expect(sanitizeProps({ agent: undefined, outcome: "failed" })).toEqual({ outcome: "failed" });
  });

  it("caps string length so no long payload can ride along", () => {
    const out = sanitizeProps({ error_class: "x".repeat(500) });
    expect(String(out.error_class).length).toBe(60);
  });
});

describe("durationBucket", () => {
  it("buckets rather than reporting a raw timing", () => {
    expect(durationBucket(30_000)).toBe("<1m");
    expect(durationBucket(3 * 60_000)).toBe("1-5m");
    expect(durationBucket(10 * 60_000)).toBe("5-15m");
    expect(durationBucket(30 * 60_000)).toBe("15-45m");
    expect(durationBucket(90 * 60_000)).toBe(">45m");
  });
});
