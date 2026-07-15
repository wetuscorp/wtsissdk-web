import { defineConfig } from "vitest/config";

export default defineConfig({
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
