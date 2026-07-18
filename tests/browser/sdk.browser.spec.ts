import { expect, test, type Page } from "@playwright/test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { WtsClient } from "../../src/types";

test("exposes the versioned IIFE without network or storage before consent", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.setContent("<!doctype html><title>SDK test</title>");
  await page.addScriptTag({ path: resolve("dist/wts-web.iife.min.js") });

  const result = await page.evaluate(async () => {
    const storageReads = { indexedDB: 0, localStorage: 0, sessionStorage: 0 };
    for (const key of Object.keys(storageReads) as Array<keyof typeof storageReads>) {
      Object.defineProperty(window, key, {
        configurable: true,
        get() {
          storageReads[key] += 1;
          return undefined;
        },
      });
    }
    const client = window.WtsWeb.createWtsClient({ sourceKey: "web_test_source" });
    const pageResult = await client.page("Pending page");
    client.destroy();
    return { pageResult, storageReads };
  });

  expect(result.pageResult).toEqual({ accepted: false, reason: "consent_pending" });
  expect(result.storageReads).toEqual({ indexedDB: 0, localStorage: 0, sessionStorage: 0 });
  expect(requests).toEqual([]);
});

test("renders a tokenized automatic Experience accessibly and retains an unhandled callback", async ({
  page,
}) => {
  const collector = await startExperienceCollector();
  try {
    // Keep the production renderer closed by default. This browser-only test
    // opens the shadow root before the SDK loads so it can activate the CTA
    // deterministically in every engine without exposing a production hook.
    await page.addInitScript(() => {
      const attachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        return attachShadow.call(this, { ...init, mode: "open" });
      };
    });
    await page.goto(`${collector.origin}/checkout`);
    await page.locator("#previous-focus").focus();
    await installIife(page, collector);

    await page.evaluate(async ({ collectorOrigin, sourceKey, verificationKey }) => {
      const client = window.WtsWeb.createWtsClient({
        sourceKey,
        consent: "granted",
        collectorOrigin,
        experiences: {
          enabled: true,
          renderMode: "automatic",
          manifestVerificationKeys: { v1: verificationKey },
          allowedCallbackKeys: ["apply_offer"],
        },
      });
      window.__wtsExperienceTestClient = client;
      await client.setExperienceConsent("contextual");
      await client.page("Checkout");
    }, collector.browserConfig);

    const host = page.locator("[data-wts-experience]");
    await expect(host).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.getAttribute("data-wts-experience") ?? null),
      )
      .not.toBeNull();
    await expect
      .poll(() =>
        host.evaluate((element) => ({
          background: element.style.getPropertyValue("--wts-experience-background-override"),
          text: element.style.getPropertyValue("--wts-experience-text-override"),
          accent: element.style.getPropertyValue("--wts-experience-accent-override"),
        })),
      )
      .toEqual({
        background: "linear-gradient(145deg, #071b34, #0b3260)",
        text: "#f8fafc",
        accent: "#0b3260",
      });

    await expect.poll(() => collector.interactionTypes).toContain("impression");

    // The CTA lives in the production renderer's closed shadow root. The test
    // makes it open before loading the SDK so it can activate the exact action
    // across Chromium, Firefox and WebKit. Its CUSTOM_CALLBACK target is
    // allowlisted but deliberately has no host handler, so the SDK must
    // neither close nor record a handled action.
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("[data-wts-experience]");
      const primary = host?.shadowRoot?.querySelector<HTMLButtonElement>(".primary");
      if (!primary) throw new Error("Experience primary action was not rendered.");
      primary.click();
    });
    await expect(host).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__wtsExperienceTestClient.getExperienceDiagnostics().lastErrorCode,
        ),
      )
      .toBe("EXPERIENCE_CALLBACK_UNHANDLED");
    expect(collector.interactionTypes).not.toContain("primary_action");

    await page.keyboard.press("Escape");
    await expect(host).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? null))
      .toBe("previous-focus");
  } finally {
    await collector.close();
  }
});

declare global {
  interface Window {
    __wtsExperienceTestClient: WtsClient;
  }
}

type BrowserCollector = {
  origin: string;
  browserConfig: {
    collectorOrigin: string;
    sourceKey: string;
    verificationKey: string;
  };
  experiencesIntegrity: string;
  interactionTypes: string[];
  close(): Promise<void>;
};

async function startExperienceCollector(): Promise<BrowserCollector> {
  const [sdk, companion] = await Promise.all([
    readFile(resolve("dist/wts-web.iife.min.js")),
    readFile(resolve("dist/wts-web-experiences.iife.min.js")),
  ]);
  const sourceKey = "web_browser_source_12345678";
  const keyPair = generateKeyPairSync("ed25519");
  const verificationKey = keyPair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const manifest = createBrowserManifest(sourceKey);
  const signedPayload = Buffer.from(JSON.stringify(manifest)).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(signedPayload, "base64url"),
    keyPair.privateKey,
  ).toString("base64url");
  const experiencesIntegrity = `sha384-${createHash("sha384").update(companion).digest("base64")}`;
  const interactionTypes: string[] = [];

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && requestUrl.pathname === "/wts-web.iife.min.js") {
      response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      response.end(sdk);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/wts-web-experiences.iife.min.js") {
      response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      response.end(companion);
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request);
      if (requestUrl.pathname === "/v3/bootstrap") {
        respondJson(response, { attributionContextId: null, serverTime: new Date().toISOString() });
        return;
      }
      if (requestUrl.pathname === "/v3/events/batch") {
        respondJson(response, {
          accepted: arrayIds(body, "events", "clientEventId"),
          duplicates: [],
          rejected: [],
        });
        return;
      }
      if (requestUrl.pathname === "/experiences/v1/bootstrap") {
        respondJson(response, {
          manifest: { untrusted: true },
          signedPayload,
          signature,
          keyId: "v1",
          expiresAt: manifest.expiresAt,
        });
        return;
      }
      if (requestUrl.pathname === "/experiences/v1/interactions/batch") {
        const interactions = arrayValue(body, "interactions");
        interactionTypes.push(
          ...interactions.flatMap((interaction) =>
            typeof interaction?.type === "string" ? [interaction.type] : [],
          ),
        );
        respondJson(response, {
          accepted: interactions.flatMap((interaction) =>
            typeof interaction?.clientInteractionId === "string"
              ? [interaction.clientInteractionId]
              : [],
          ),
          duplicates: [],
          rejected: [],
        });
        return;
      }
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<!doctype html><button id="previous-focus">Checkout</button>');
  }
  const origin = await listen(server);
  return {
    origin,
    browserConfig: { collectorOrigin: origin, sourceKey, verificationKey },
    experiencesIntegrity,
    interactionTypes,
    close: () => close(server),
  };
}

async function installIife(page: Page, collector: BrowserCollector) {
  await page.evaluate(
    async ({ origin, integrity }) => {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${origin}/wts-web.iife.min.js`;
        script.dataset.wtsWebExperiencesIntegrity = integrity;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Unable to load the Web SDK IIFE."));
        document.head.append(script);
      });
    },
    { origin: collector.origin, integrity: collector.experiencesIntegrity },
  );
}

function createBrowserManifest(sourceKey: string) {
  return {
    schemaVersion: 1,
    sourceId: "source_browser_1",
    sourceKey,
    sourceManifestVersion: 1,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    campaigns: [
      {
        campaignId: "campaign_browser_1",
        campaignVersionId: "version_browser_1",
        priority: 100,
        startsAt: null,
        endsAt: null,
        placement: "modal",
        defaultLocale: "en",
        trigger: {
          type: "page_view",
          match: { kind: "pathname_exact", value: "/checkout" },
        },
        targeting: {
          kind: "condition",
          field: "platform",
          operator: "equals",
          value: "web",
        },
        frequency: { session: 1, daily: 1 },
        variants: [
          {
            id: "variant_browser_1",
            key: "control",
            content: {
              translations: {
                en: {
                  title: "Checkout benefit",
                  description: "A safe Experience test.",
                  primaryAction: {
                    id: "apply_offer",
                    label: "Apply offer",
                    type: "CUSTOM_CALLBACK",
                    target: "apply_offer",
                  },
                },
              },
              closeable: true,
              themePreset: "light",
              backgroundToken: "brand",
              textToken: "inverse",
              accentToken: "secondary",
              delaySeconds: 0,
              autoCloseSeconds: null,
            },
            asset: null,
          },
        ],
        requiresPersonalization: false,
        grant: "v1.browser.payload.signature",
        assignment: {
          assignmentId: "assignment_browser_1",
          kind: "variant",
          variantId: "variant_browser_1",
        },
      },
    ],
  };
}

function arrayValue(value: unknown, key: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate)
    ? candidate.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
      )
    : [];
}

function arrayIds(value: unknown, key: string, idKey: string): string[] {
  return arrayValue(value, key).flatMap((item) =>
    typeof item[idKey] === "string" ? [item[idKey]] : [],
  );
}

function respondJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let payload = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      payload += chunk;
    });
    request.once("end", () => {
      try {
        resolveBody(payload ? JSON.parse(payload) : {});
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Invalid browser collector JSON."));
      }
    });
    request.once("error", reject);
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolveOrigin, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine the browser collector address."));
        return;
      }
      resolveOrigin(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
