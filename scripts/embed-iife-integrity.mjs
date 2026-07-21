import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const placeholder = "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const companionUrl = new URL("../dist/wts-web-experiences.iife.min.js", import.meta.url);
const mainUrl = new URL("../dist/wts-web.iife.min.js", import.meta.url);
const companion = await readFile(companionUrl);
const integrity = `sha384-${createHash("sha384").update(companion).digest("base64")}`;
const main = await readFile(mainUrl, "utf8");
if (!main.includes(placeholder)) {
  throw new Error("The primary IIFE does not contain the Experiences integrity placeholder.");
}
await writeFile(mainUrl, main.replaceAll(placeholder, integrity), "utf8");
console.log(`Embedded Experiences companion integrity ${integrity}.`);
