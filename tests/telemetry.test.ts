import { describe, expect, it } from "vitest";
import { CLIENT_EVENTS, durationBucket, sanitizeProps } from "@/lib/telemetry";

/** The allowlist IS the privacy contract, and it is what makes always-on
 * collection acceptable. Dhruva runs inside customer codebases, so these
 * tests exist to fail loudly if a future change lets project-identifying
 * data through. */
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

describe("the always-on contract", () => {
  it("has no way to smuggle an IP address or location through the allowlist", () => {
    const out = sanitizeProps({
      ip: "203.0.113.7",
      $ip: "203.0.113.7",
      city: "Hyderabad",
      country: "IN",
      agent: "claude",
    } as never);
    expect(out).toEqual({ agent: "claude" });
  });

  it("drops anything identifying a person or an organisation", () => {
    const out = sanitizeProps({
      user_email: "someone@example.com",
      user_name: "A Person",
      company: "Acme Ltd",
      repo: "acme/salesforce",
      outcome: "done",
    } as never);
    expect(out).toEqual({ outcome: "done" });
  });
});

describe("client event vocabulary", () => {
  it("only allows the three UI-observable events", () => {
    expect([...CLIENT_EVENTS].sort()).toEqual([
      "app_opened",
      "feature_used",
      "project_attached",
    ]);
  });

  it("does not let the browser send run/gate events (server-owned)", () => {
    expect(CLIENT_EVENTS.has("run_started")).toBe(false);
    expect(CLIENT_EVENTS.has("run_finished")).toBe(false);
    expect(CLIENT_EVENTS.has("gate_resolved")).toBe(false);
    expect(CLIENT_EVENTS.has("step_failed")).toBe(false);
  });

  it("sanitizes a feature_used payload down to the feature name", () => {
    const out = sanitizeProps({
      feature: "workflows",
      project_path: "D:/customer/acme-sfdx",
      file: "Billing.cls",
    } as never);
    expect(out).toEqual({ feature: "workflows" });
  });
});
