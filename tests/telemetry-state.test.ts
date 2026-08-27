import { afterEach, describe, expect, it } from "vitest";
import { telemetryState } from "@/lib/telemetry";

/** Analytics are ALWAYS ON when a backend is configured - there is no
 * per-user opt-in, by design. These tests pin that behavior so a future
 * refactor cannot quietly reintroduce a consent gate (and silently stop
 * collecting), or ignore the environment kill switches. */
describe("telemetryState", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is ON out of the box - the project token ships with the build", async () => {
    delete process.env.DHRUVA_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const s = await telemetryState();
    expect(s.configured).toBe(true);
    expect(s.enabled).toBe(true);
  });

  it("lets an env key override the shipped token", async () => {
    process.env.DHRUVA_POSTHOG_KEY = "phc_test";
    const s = await telemetryState();
    expect(s.configured).toBe(true);
    expect(s.enabled).toBe(true);
  });

  it("respects DHRUVA_TELEMETRY=0", async () => {
    process.env.DHRUVA_POSTHOG_KEY = "phc_test";
    process.env.DHRUVA_TELEMETRY = "0";
    const s = await telemetryState();
    expect(s.envDisabled).toBe(true);
    expect(s.enabled).toBe(false);
  });

  it("honors the DO_NOT_TRACK convention", async () => {
    process.env.DHRUVA_POSTHOG_KEY = "phc_test";
    process.env.DO_NOT_TRACK = "1";
    const s = await telemetryState();
    expect(s.envDisabled).toBe(true);
    expect(s.enabled).toBe(false);
  });
});
