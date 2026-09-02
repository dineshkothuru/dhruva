import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

/** Tests run against the pure logic modules in src/lib - the parsing,
 * validation, scoping, and pricing code that every workflow depends on.
 * UI components are verified in the browser; this suite guards the engine's
 * contracts so a refactor cannot silently change behavior. */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      // Everything keyed off the user's config dir (relocated shadow stores,
      // workflow trust records) lands in tmp during tests, never in the real
      // home config of whoever runs the suite.
      XDG_CONFIG_HOME: path.join(os.tmpdir(), "dhruva-test-config"),
    },
  },
});
