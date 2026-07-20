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
if (!iife.includes(experiencesSri) || !iife.includes("integrity")) {
  throw new Error("The primary IIFE must embed the exact Experiences companion SRI value.");
}
await verifyIifeTestSessionFacade(iife, testSessionIife, experiencesIife);
await verifyIifeExperiencesIntegrity(iife, experiencesIife, experiencesSri);

const esm = await import(new URL("../dist/index.js", import.meta.url).href);
const cjs = createRequire(import.meta.url)("../dist/index.cjs");
if (typeof esm.createWtsClient !== "function" || typeof cjs.createWtsClient !== "function") {
  throw new Error("ESM and CJS entrypoints must expose createWtsClient during SSR import.");
}

console.log(`Package verified: ${gzipBytes} gzip bytes; SRI ${sri}.`);

async function verifyIifeTestSessionFacade(iifeSource, testSessionSource, experienceSource) {
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
        if (script.dataset.wtsWebExperiences) {
          vm.runInContext(experienceSource.toString(), context);
        } else if (script.dataset.wtsWebTestSession) {
          vm.runInContext(testSessionSource.toString(), context);
        } else {
          throw new Error("Unexpected companion script.");
        }
        script.onload?.();
      },
    },
  };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    requests.push(path);
    if (path === "/v3/bootstrap") {
      return jsonResponse({ attributionContextId: null, serverTime: futureIso() });
    }
    if (path === "/experiences/v2/bootstrap") {
      return jsonResponse({});
    }
    if (path === "/sdk/test/v2/pair") {
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
        requiredSdkVersion: "0.5.0-alpha.1",
        testPlan: emptyTestPlan(),
      });
    }
    if (path === "/sdk/test/v2/handshake") {
      return jsonResponse({
        accepted: true,
        compatible: true,
        requiredSdkVersion: "0.5.0-alpha.1",
        checks: [],
        testPlan: emptyTestPlan(),
      });
    }
    if (path === "/sdk/test/v2/signals/batch") {
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
    clearInterval,
    console,
    document,
    fetch,
    queueMicrotask,
    setTimeout,
    setInterval,
    window,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(iifeSource.toString(), context);

  const client = window.WtsWeb.createWtsClient({
    sourceKey: "web_package_test",
  });
  await client.setConsent("granted");
  for (const method of ["joinTestSession", "leaveTestSession", "getTestSessionDiagnostics"]) {
    if (typeof client[method] !== "function") {
      throw new Error(`The primary IIFE client does not expose ${method}.`);
    }
  }
  const result = await client.joinTestSession("A2B3C4D5E6F7G8H9");
  if (!result.joined || !result.compatible || !requests.includes("/sdk/test/v2/handshake")) {
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

async function verifyIifeExperiencesIntegrity(iifeSource, experienceSource, experienceSri) {
  let injectedExperienceScript;
  const unverifiedFactory = {
    create() {
      throw new Error("An unverified Experiences companion must never run.");
    },
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
    __wtsWebExperiencesFactory: unverifiedFactory,
  };
  const document = {
    currentScript: {
      src: "https://cdn.example.test/wts-web.iife.min.js",
      dataset: {},
    },
    scripts: [],
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return { dataset: {} };
    },
    head: {
      append(script) {
        if (!script.dataset.wtsWebExperiences) {
          throw new Error("Unexpected non-Experience companion injection.");
        }
        injectedExperienceScript = script;
        document.currentScript = script;
        vm.runInContext(experienceSource.toString(), context);
        script.onload?.();
      },
    },
  };
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v3/bootstrap") {
      return jsonResponse({ attributionContextId: null, serverTime: futureIso() });
    }
    if (path === "/experiences/v2/bootstrap") {
      // The loader is the subject of this check. An untrusted response still
      // exercises fail-closed manifest handling after the SRI-checked load.
      return jsonResponse({
        manifest: {},
        signedPayload: "e30",
        signature: "invalid",
        keyId: "v1",
        expiresAt: futureIso(),
      });
    }
    throw new Error(`Unexpected IIFE Experience request: ${path}`);
  };
  const sandbox = {
    AbortController,
    URL,
    TextDecoder,
    TextEncoder,
    atob,
    clearTimeout,
    clearInterval,
    console,
    crypto: globalThis.crypto,
    document,
    fetch,
    queueMicrotask,
    setTimeout,
    setInterval,
    window,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(iifeSource.toString(), context);

  const client = window.WtsWeb.createWtsClient({
    sourceKey: "web_package_experience_test",
  });
  await client.setConsent("granted");
  if (!injectedExperienceScript) {
    throw new Error("The primary IIFE did not load the Experiences companion when enabled.");
  }
  if (
    injectedExperienceScript.integrity !== experienceSri ||
    injectedExperienceScript.crossOrigin !== "anonymous"
  ) {
    throw new Error("The Experiences companion was not injected with the exact SRI pin.");
  }
  if (window.__wtsWebExperiencesFactory === unverifiedFactory) {
    throw new Error("The primary IIFE trusted an unverified Experiences companion factory.");
  }
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
