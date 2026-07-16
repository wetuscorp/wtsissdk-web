import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const releaseScript = new URL("./publish-release.mjs", import.meta.url);

runScenario({
  name: "matching existing artifact",
  publishedShasum: "a".repeat(40),
  localShasum: "a".repeat(40),
  expectedStatus: 0,
  expectedLog: "already published with the expected artifact",
  expectedCommands: ["view", "pack"],
});

runScenario({
  name: "different existing artifact",
  publishedShasum: "a".repeat(40),
  localShasum: "b".repeat(40),
  expectedStatus: 1,
  expectedLog: "already exists with a different artifact",
  expectedCommands: ["view", "pack"],
});

runScenario({
  name: "new prerelease artifact",
  publishedShasum: null,
  localShasum: "c".repeat(40),
  expectedStatus: 0,
  expectedLog: "",
  expectedCommands: ["view", "publish --access public --tag next"],
});

console.log("Release publishing guard contract passed.");

function runScenario({
  name,
  publishedShasum,
  localShasum,
  expectedStatus,
  expectedLog,
  expectedCommands,
}) {
  const root = mkdtempSync(join(tmpdir(), "wts-web-release-"));
  const scriptsDirectory = join(root, "scripts");
  const binaryDirectory = join(root, "bin");
  const commandLog = join(root, "commands.log");
  mkdirSync(scriptsDirectory);
  mkdirSync(binaryDirectory);
  copyFileSync(releaseScript, join(scriptsDirectory, "publish-release.mjs"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@wetusco/web-sdk", version: "0.1.0-alpha.1", type: "module" }),
  );

  const fakeNpm = join(binaryDirectory, "npm");
  writeFileSync(
    fakeNpm,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$WTS_COMMAND_LOG"
case "$1" in
  view)
    ${
      publishedShasum
        ? `printf '"${publishedShasum}"\\n'`
        : `printf '%s\\n' 'npm error code E404' >&2
    exit 1`
    }
    ;;
  pack)
    touch wetusco-web-sdk-0.1.0-alpha.1.tgz
    printf '%s\\n' '[{"filename":"wetusco-web-sdk-0.1.0-alpha.1.tgz","shasum":"${localShasum}"}]'
    ;;
  publish)
    ;;
  *)
    exit 64
    ;;
esac
`,
  );
  chmodSync(fakeNpm, 0o755);

  const result = spawnSync(process.execPath, [join(scriptsDirectory, "publish-release.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`,
      WTS_COMMAND_LOG: commandLog,
    },
  });

  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, new RegExp(escapeRegExp(expectedLog)));
  assert.deepEqual(
    readFileSync(commandLog, "utf8")
      .trim()
      .split("\n")
      .map((command) => {
        if (command.startsWith("view ")) return "view";
        if (command.startsWith("pack ")) return "pack";
        return command;
      }),
    expectedCommands,
    name,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
