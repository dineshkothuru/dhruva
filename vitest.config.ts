import { defineConfig } from "vitest/config";
import path from "node:path";

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
  },
});
