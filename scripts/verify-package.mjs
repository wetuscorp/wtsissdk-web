import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.name !== "@wetusco/web-sdk") throw new Error("Unexpected npm package name.");
if (Object.keys(packageJson.dependencies ?? {}).length > 0)
  throw new Error("Runtime dependencies are not allowed.");

const iife = await readFile(new URL("../dist/wts-web.iife.min.js", import.meta.url));
const gzipBytes = gzipSync(iife).byteLength;
if (gzipBytes > 15 * 1024) throw new Error(`IIFE gzip budget exceeded: ${gzipBytes} bytes.`);

const sri = `sha384-${createHash("sha384").update(iife).digest("base64")}`;
await writeFile(new URL("../dist/wts-web.iife.min.js.sri", import.meta.url), `${sri}\n`, "utf8");

const esm = await import(new URL("../dist/index.js", import.meta.url).href);
const cjs = createRequire(import.meta.url)("../dist/index.cjs");
if (typeof esm.createWtsClient !== "function" || typeof cjs.createWtsClient !== "function") {
  throw new Error("ESM and CJS entrypoints must expose createWtsClient during SSR import.");
}

console.log(`Package verified: ${gzipBytes} gzip bytes; SRI ${sri}.`);
