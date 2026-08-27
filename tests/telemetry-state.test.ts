import { afterEach, describe, expect, it, vi } from "vitest";
import { telemetryState } from "@/lib/telemetry";

/** The opt-in prompt and the Setup card both render off telemetryState, so a
 * mistake here either nags a user with no backend or silently never asks. */
describe("telemetryState", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it("reports not-configured when no key is set", async () => {
    delete process.env.DHRUVA_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const s = await telemetryState();
    expect(s.configured).toBe(false);
    expect(s.enabled).toBe(false);
  });

  it("reports configured once a key exists", async () => {
    process.env.DHRUVA_POSTHOG_KEY = "phc_test";
    expect((await telemetryState()).configured).toBe(true);
  });

  it("treats DHRUVA_TELEMETRY=0 as a hard off switch", async () => {
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
