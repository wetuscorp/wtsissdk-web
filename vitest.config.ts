import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@wts/experience-loader": fileURLToPath(
        new URL("./src/experiences/loader.ts", import.meta.url),
      ),
      "@wts/test-session-loader": fileURLToPath(
        new URL("./src/test-session-loader.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/*.test.ts"],
    environment: "happy-dom",
    setupFiles: ["fake-indexeddb/auto"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/iife.ts"],
    },
  },
});
