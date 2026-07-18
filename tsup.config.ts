import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const iifeTestSessionLoader = fileURLToPath(
  new URL("./src/test-session-loader.iife.ts", import.meta.url),
);
const iifeExperienceLoader = fileURLToPath(
  new URL("./src/experiences/loader.iife.ts", import.meta.url),
);

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    target: "es2020",
    splitting: true,
    treeshake: true,
  },
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    dts: false,
    sourcemap: true,
    clean: false,
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
    esbuildOptions(options) {
      options.alias = {
        ...options.alias,
        "@wts/experience-loader": iifeExperienceLoader,
        "@wts/test-session-loader": iifeTestSessionLoader,
      };
    },
  },
  {
    entry: { "wts-web-experiences": "src/experiences-iife.ts" },
    format: ["iife"],
    globalName: "WtsWebExperiencesBundle",
    outExtension: () => ({ js: ".iife.min.js" }),
    sourcemap: true,
    minify: true,
    target: "es2020",
    splitting: false,
    treeshake: true,
  },
  {
    entry: { "wts-web-test-session": "src/test-session-iife.ts" },
    format: ["iife"],
    globalName: "WtsWebTestSessionBundle",
    outExtension: () => ({ js: ".iife.min.js" }),
    sourcemap: true,
    minify: true,
    target: "es2020",
    splitting: false,
    treeshake: true,
  },
]);
