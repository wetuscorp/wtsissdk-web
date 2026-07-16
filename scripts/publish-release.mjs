import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageSpec = `${packageJson.name}@${packageJson.version}`;
const publishedShasum = readPublishedShasum(packageSpec);

if (!publishedShasum) {
  execFileSync(
    "npm",
    [
      "publish",
      "--access",
      "public",
      "--tag",
      packageJson.version.includes("-") ? "next" : "latest",
    ],
    { stdio: "inherit" },
  );
  process.exit(0);
}

const packResult = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { encoding: "utf8" }),
)[0];

try {
  if (packResult.shasum !== publishedShasum) {
    throw new Error(
      `${packageSpec} already exists with a different artifact: ` +
        `registry=${publishedShasum}, local=${packResult.shasum}`,
    );
  }
} finally {
  unlinkSync(packResult.filename);
}

console.log(`${packageSpec} is already published with the expected artifact.`);

function readPublishedShasum(packageSpec) {
  const result = spawnSync("npm", ["view", packageSpec, "dist.shasum", "--json"], {
    encoding: "utf8",
  });

  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
      throw new Error(`npm returned an invalid dist.shasum for ${packageSpec}.`);
    }
    return value;
  }

  if (result.stderr.includes("E404")) {
    return null;
  }

  process.stderr.write(result.stderr);
  throw new Error(`Unable to query npm for ${packageSpec}.`);
}
