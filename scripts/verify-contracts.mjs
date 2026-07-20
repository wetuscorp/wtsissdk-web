import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../.wts-contracts.json", import.meta.url), "utf8"),
);
if (manifest.protocolVersion !== 3) throw new Error("Web SDK must pin Protocol V3.");
if (manifest.identityProtocolVersion !== 1) {
  throw new Error("Web SDK must pin Identity Protocol V1.");
}
if (manifest.experiencesProtocolVersion !== 2) {
  throw new Error("Web SDK must pin Experiences Protocol V2.");
}
if (manifest.testSessionProtocolVersion !== 2) {
  throw new Error("Web SDK must pin SDK Test Session Protocol V2.");
}

for (const [path, expected] of Object.entries(manifest.files)) {
  const contents = await readFile(new URL(`../${path}`, import.meta.url));
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== expected) throw new Error(`Contract drift detected for ${path}.`);
}

console.log(
  `Verified ${Object.keys(manifest.files).length} Protocol V3, Identity V1, Experiences V2, and SDK Test Session V2 contract files.`,
);
