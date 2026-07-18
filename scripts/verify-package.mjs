import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.name !== "@wetusco/wts-web-sdk") throw new Error("Unexpected npm package name.");
if (Object.keys(packageJson.dependencies ?? {}).length > 0)
  throw new Error("Runtime dependencies are not allowed.");

const iife = await readFile(new URL("../dist/wts-web.iife.min.js", import.meta.url));
const gzipBytes = gzipSync(iife).byteLength;
if (gzipBytes > 15 * 1024) throw new Error(`IIFE gzip budget exceeded: ${gzipBytes} bytes.`);

const testSessionIife = await readFile(
  new URL("../dist/wts-web-test-session.iife.min.js", import.meta.url),
);
const experiencesIife = await readFile(
  new URL("../dist/wts-web-experiences.iife.min.js", import.meta.url),
);
if (!iife.includes("wts-web-test-session.iife.min.js")) {
  throw new Error("The primary IIFE must retain the lazy SDK Test & Validate loader.");
}
if (!iife.includes("wts-web-experiences.iife.min.js")) {
  throw new Error("The primary IIFE must retain the lazy Experiences loader.");
}
for (const method of ["joinTestSession", "leaveTestSession", "getTestSessionDiagnostics"]) {
  if (!iife.includes(method)) {
    throw new Error(`The primary IIFE is missing the ${method} test-session facade.`);
  }
}
if (!testSessionIife.includes("__wtsWebTestSessionFactory")) {
  throw new Error("The SDK Test & Validate companion IIFE does not expose its runtime factory.");
}
if (!experiencesIife.includes("__wtsWebExperiencesFactory")) {
  throw new Error("The Experiences companion IIFE does not expose its runtime factory.");
}
await verifyIifeTestSessionFacade(iife, testSessionIife);

const sri = `sha384-${createHash("sha384").update(iife).digest("base64")}`;
await writeFile(new URL("../dist/wts-web.iife.min.js.sri", import.meta.url), `${sri}\n`, "utf8");
const testSessionSri = `sha384-${createHash("sha384").update(testSessionIife).digest("base64")}`;
await writeFile(
  new URL("../dist/wts-web-test-session.iife.min.js.sri", import.meta.url),
  `${testSessionSri}\n`,
  "utf8",
);
const experiencesSri = `sha384-${createHash("sha384").update(experiencesIife).digest("base64")}`;
await writeFile(
  new URL("../dist/wts-web-experiences.iife.min.js.sri", import.meta.url),
  `${experiencesSri}\n`,
  "utf8",
);

const esm = await import(new URL("../dist/index.js", import.meta.url).href);
const cjs = createRequire(import.meta.url)("../dist/index.cjs");
if (typeof esm.createWtsClient !== "function" || typeof cjs.createWtsClient !== "function") {
  throw new Error("ESM and CJS entrypoints must expose createWtsClient during SSR import.");
}

console.log(`Package verified: ${gzipBytes} gzip bytes; SRI ${sri}.`);

async function verifyIifeTestSessionFacade(iifeSource, testSessionSource) {
  const requests = [];
  const window = {
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
    currentScript: { src: "https://cdn.example.test/wts-web.iife.min.js" },
    scripts: [],
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return { dataset: {} };
    },
    head: {
      append(script) {
        document.currentScript = script;
        vm.runInContext(testSessionSource.toString(), context);
        script.onload?.();
      },
    },
  };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    requests.push(path);
    if (path === "/test/v1/pair") {
      return jsonResponse({
        session: { id: "session_package_test", status: "running", expiresAt: futureIso() },
        participant: {
          id: "participant_package_test",
          sourceId: "source_package_test",
          sourceType: "web_app",
          status: "paired",
        },
        sessionToken: "t".repeat(32),
        testProfile: { externalUserId: "test_profile_package" },
        requiredSdkVersion: "0.4.0-alpha.1",
        testPlan: emptyTestPlan(),
      });
    }
    if (path === "/test/v1/handshake") {
      return jsonResponse({
        accepted: true,
        compatible: true,
        requiredSdkVersion: "0.4.0-alpha.1",
        checks: [],
        testPlan: emptyTestPlan(),
      });
    }
    if (path === "/test/v1/signals/batch") {
      return jsonResponse({
        accepted: body.signals.map((signal) => signal.clientSignalId),
        duplicates: [],
        rejected: [],
      });
    }
    throw new Error(`Unexpected IIFE test-session request: ${path}`);
  };
  const sandbox = {
    AbortController,
    URL,
    crypto: globalThis.crypto,
    clearTimeout,
    console,
    document,
    fetch,
    queueMicrotask,
    setTimeout,
    window,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(iifeSource.toString(), context);

  const client = window.WtsWeb.createWtsClient({
    sourceKey: "web_package_test",
    consent: "pending",
  });
  for (const method of ["joinTestSession", "leaveTestSession", "getTestSessionDiagnostics"]) {
    if (typeof client[method] !== "function") {
      throw new Error(`The primary IIFE client does not expose ${method}.`);
    }
  }
  const result = await client.joinTestSession("A2B3C4D5E6F7G8H9");
  if (!result.joined || !result.compatible || !requests.includes("/test/v1/handshake")) {
    throw new Error("The primary IIFE could not lazy-load the SDK Test & Validate companion.");
  }
  const diagnostics = client.getTestSessionDiagnostics();
  if (!diagnostics.joined || !diagnostics.compatible) {
    throw new Error(
      "The primary IIFE test-session diagnostics are not callable after lazy loading.",
    );
  }
  await client.leaveTestSession();
  client.destroy();
}

function jsonResponse(value) {
  return { ok: true, json: async () => value };
}

function futureIso() {
  return new Date(Date.now() + 60_000).toISOString();
}

function emptyTestPlan() {
  return {
    profile: null,
    events: [],
    deepLink: null,
    experience: null,
    screen: null,
  };
}
