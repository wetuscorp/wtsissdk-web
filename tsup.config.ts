import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const iifeTestSessionLoader = fileURLToPath(
  new URL("./src/test-session-loader.iife.ts", import.meta.url),
);
const iifeExperienceLoader = fileURLToPath(
  new URL("./src/experiences/loader.iife.ts", import.meta.url),
);
const trustDefine = {
  __WTS_EXPERIENCE_ROOT_PUBLIC_KEY__: JSON.stringify(
    process.env.WTS_EXPERIENCE_ROOT_PUBLIC_KEY?.trim() ?? "",
  ),
};

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
    define: trustDefine,
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
    define: trustDefine,
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
    define: trustDefine,
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
    define: trustDefine,
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
    define: trustDefine,
  },
]);
