import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    target: "es2020",
    splitting: false,
    treeshake: true,
  },
  {
    entry: { "wts-web": "src/iife.ts" },
    format: ["iife"],
    globalName: "WtsWebBundle",
    outExtension: () => ({ js: ".iife.min.js" }),
    sourcemap: true,
    minify: true,
    target: "es2020",
    splitting: false,
    treeshake: true,
  },
]);
