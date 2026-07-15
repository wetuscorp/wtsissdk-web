import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../.wts-contracts.json", import.meta.url), "utf8"),
);
if (manifest.protocolVersion !== 2) throw new Error("Web SDK must pin Protocol V2.");

for (const [path, expected] of Object.entries(manifest.files)) {
  const contents = await readFile(new URL(`../${path}`, import.meta.url));
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== expected) throw new Error(`Contract drift detected for ${path}.`);
}

console.log(`Verified ${Object.keys(manifest.files).length} Protocol V2 contract files.`);
