import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyExperienceManifestPayload } from "../src/experiences/manifest-verifier";
import { ExperienceRuntime } from "../src/experiences/runtime";
import type {
  BootstrapResponse,
  ExperienceManifest,
  ManifestCampaign,
  OnlineKeyset,
  QueuedExperience,
} from "../src/experiences/types";
import { MemoryStorage } from "../src/storage";
import type { ExperienceContent, StoredExperienceManifest } from "../src/types";

const sourceKey = "web_source_v2_test";

describe("Experiences V2 trust", () => {
  it("accepts root-signed leaf rotation without changing the embedded root", async () => {
    const trust = createTrust();
    const rotated = generateKeyPairSync("ed25519");
    trust.addLeaf("leaf-2", rotated);
    const envelope = trust.signManifest(manifest([]), "leaf-2", rotated.privateKey);

    await expect(
      verifyExperienceManifestPayload({
        signedPayload: envelope.signedPayload,
        kid: envelope.keyId,
        signature: envelope.signature,
        onlineKeyset: envelope.onlineKeyset,
        expectedSourceKey: sourceKey,
        rootPublicKey: trust.rootPublicKey,
      }),
    ).resolves.toMatchObject({ schemaVersion: 2, sourceKey, manifestVersion: 7 });
  });

  it("fails closed for source replay, unknown leaf, tamper, and expiry", async () => {
    const trust = createTrust();
    const valid = trust.signManifest(manifest([]));
    const verify = (
      overrides: Partial<Parameters<typeof verifyExperienceManifestPayload>[0]> = {},
    ) =>
      verifyExperienceManifestPayload({
        signedPayload: valid.signedPayload,
        kid: valid.keyId,
        signature: valid.signature,
        onlineKeyset: valid.onlineKeyset,
        expectedSourceKey: sourceKey,
        rootPublicKey: trust.rootPublicKey,
        ...overrides,
      });

    await expect(verify({ expectedSourceKey: "another_source" })).rejects.toThrow(
      "EXPERIENCE_MANIFEST_SOURCE_MISMATCH",
    );
    await expect(verify({ kid: "unknown" })).rejects.toThrow("EXPERIENCE_MANIFEST_KEY_UNTRUSTED");
    await expect(verify({ signature: mutate(valid.signature) })).rejects.toThrow(
      "EXPERIENCE_MANIFEST_SIGNATURE_INVALID",
    );

    const expired = trust.signManifest(
      manifest([], {
        issuedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
    );
    await expect(
      verifyExperienceManifestPayload({
        signedPayload: expired.signedPayload,
        kid: expired.keyId,
        signature: expired.signature,
        onlineKeyset: expired.onlineKeyset,
        expectedSourceKey: sourceKey,
        rootPublicKey: trust.rootPublicKey,
      }),
    ).rejects.toThrow("EXPERIENCE_MANIFEST_EXPIRED");
  });
});

describe("Experiences V2 runtime", () => {
  const runtimes: ExperienceRuntime[] = [];

  afterEach(() => {
    for (const runtime of runtimes) runtime.destroy();
    runtimes.length = 0;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("refreshes a signed manifest and automatically queues at most five campaigns by priority", async () => {
    const trust = createTrust();
    const campaigns = Array.from({ length: 6 }, (_, index) =>
      campaign(`campaign-${index}`, 100 - index),
    );
    const bootstrap = trust.signManifest(manifest(campaigns));
    const requests: Array<Record<string, unknown>> = [];
    stubExperienceFetch(bootstrap, requests);
    const runtime = createRuntime(trust.rootPublicKey);
    runtimes.push(runtime);

    await runtime.setConsent("granted");
    runtime.evaluate(pageContext());

    await vi.waitFor(() => expect(runtime.diagnostics().presenting).toBe(true));
    expect(runtime.diagnostics()).toMatchObject({
      consent: "granted",
      decisionMode: "contextual",
      manifestVersion: 7,
      queued: 4,
    });
    expect(document.querySelectorAll("[data-wts-experience]")).toHaveLength(1);
    const bootstrapBody = requests.find((item) => item.path === "/experiences/v2/bootstrap");
    expect(bootstrapBody).toMatchObject({ schemaVersion: 2 });
    expect(bootstrapBody).not.toHaveProperty("consent");
    expect(bootstrapBody).not.toHaveProperty("settings");
    expect(bootstrapBody).not.toHaveProperty("profileConsentGranted");
  });

  it("records an advanced action as unhandled and leaves the Experience open", async () => {
    const nativeAttachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return nativeAttachShadow.call(this, { ...init, mode: "open" });
    });
    const trust = createTrust();
    const interactions: Array<Record<string, unknown>> = [];
    stubExperienceFetch(
      trust.signManifest(
        manifest([
          campaign(
            "advanced-action",
            10,
            {
              primaryAction: {
                id: "open_settings",
                label: "Open",
                type: "OPEN_INTERNAL_ROUTE",
                target: "/settings",
              },
            },
            {
              backgroundToken: "brand",
              textToken: "inverse",
              accentToken: "secondary",
            },
          ),
        ]),
      ),
      [],
      interactions,
    );
    const runtime = createRuntime(trust.rootPublicKey);
    runtime.onAction(() => false);
    runtimes.push(runtime);

    await runtime.setConsent("granted");
    runtime.evaluate(pageContext());
    await vi.waitFor(() => expect(runtime.diagnostics().presenting).toBe(true));
    const shadow = document.querySelector<HTMLElement>("[data-wts-experience]")?.shadowRoot;
    const surface = shadow?.querySelector<HTMLElement>('[role="dialog"]');
    expect(surface).toMatchObject({
      tabIndex: -1,
    });
    expect(surface?.getAttribute("aria-modal")).toBe("true");
    expect(surface?.getAttribute("aria-labelledby")).toBe(
      shadow?.querySelector("h2")?.getAttribute("id"),
    );
    expect(surface?.getAttribute("aria-describedby")).toBe(
      shadow?.querySelector("p")?.getAttribute("id"),
    );
    expect(shadow?.querySelector('[aria-label="Close"]')).not.toBeNull();
    const host = document.querySelector<HTMLElement>("[data-wts-experience]");
    expect(host?.style.getPropertyValue("--wts-experience-background-override")).toBe(
      "linear-gradient(145deg, #071b34, #0b3260)",
    );
    expect(host?.style.getPropertyValue("--wts-experience-text-override")).toBe("#f8fafc");
    expect(host?.style.getPropertyValue("--wts-experience-accent-override")).toBe("#0b3260");
    const button = shadow?.querySelector<HTMLButtonElement>("button.primary");
    button?.click();

    await vi.waitFor(() =>
      expect(interactions).toContainEqual(
        expect.objectContaining({
          type: "primary_action",
          actionOutcome: "unhandled",
        }),
      ),
    );
    expect(runtime.diagnostics().presenting).toBe(true);
  });

  it("cancels an active delayed render when consent is revoked", async () => {
    const trust = createTrust();
    stubExperienceFetch(
      trust.signManifest(manifest([campaign("delayed", 10, {}, { delaySeconds: 30 })])),
      [],
    );
    const runtime = createRuntime(trust.rootPublicKey);
    runtimes.push(runtime);

    await runtime.setConsent("granted");
    runtime.evaluate(pageContext());
    await vi.waitFor(() => expect(document.querySelector("[data-wts-experience]")).not.toBeNull());
    await runtime.setConsent("denied");

    expect(document.querySelector("[data-wts-experience]")).toBeNull();
    expect(runtime.diagnostics()).toMatchObject({
      consent: "denied",
      queued: 0,
      presenting: false,
    });
  });

  it("drops an already queued candidate after its signed manifest expires", async () => {
    const trust = createTrust();
    const runtime = createRuntime(trust.rootPublicKey);
    runtimes.push(runtime);
    const internals = runtime as unknown as {
      consent: "granted";
      queue: QueuedExperience[];
    };
    internals.consent = "granted";
    internals.queue = [queuedExperience({ manifestExpiresAt: Date.now() - 1 })];

    await expect(runtime.presentNext()).resolves.toBe(false);
    expect(runtime.diagnostics().queued).toBe(0);
  });

  it("clears queued interactions when identity changes", async () => {
    const storage = new MemoryStorage();
    await storage.enqueueExperience({
      clientInteractionId: "00000000-0000-4000-8000-000000000010",
      grant: "leaf-1.payload.signature",
      campaignId: "campaign-1",
      campaignVersionId: "campaign-1-v1",
      assignmentId: "assignment-1",
      variantId: "variant-1",
      exposureId: "exposure-1",
      type: "eligible",
      actionId: null,
      actionOutcome: null,
      triggerEventId: null,
      occurredAt: new Date().toISOString(),
      metadata: { platform: "web", sdkVersion: "0.5.0-alpha.1", locale: "en" },
      failureCode: null,
    });
    const runtime = new ExperienceRuntime({
      sourceKey,
      collectorOrigin: "https://collect.example.test",
      timeoutMs: 500,
      debug: false,
      getConsent: () => "granted",
      getIdentity: () => ({
        anonymousId: "00000000-0000-4000-8000-000000000001",
        sessionId: "00000000-0000-4000-8000-000000000002",
      }),
      getStorage: () => storage,
    });
    runtimes.push(runtime);

    await runtime.identityChanged();

    expect((await storage.load()).experienceQueue).toEqual([]);
  });

  it("rejects unsafe action schemes and keeps the Experience open", async () => {
    const nativeAttachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return nativeAttachShadow.call(this, { ...init, mode: "open" });
    });
    const trust = createTrust();
    const interactions: Array<Record<string, unknown>> = [];
    stubExperienceFetch(
      trust.signManifest(
        manifest([
          campaign("unsafe-action", 10, {
            primaryAction: {
              id: "unsafe",
              label: "Unsafe",
              type: "OPEN_DEEP_LINK",
              target: "javascript:alert(1)",
            },
          }),
        ]),
      ),
      [],
      interactions,
    );
    const runtime = createRuntime(trust.rootPublicKey);
    runtimes.push(runtime);

    await runtime.setConsent("granted");
    runtime.evaluate(pageContext());
    await vi.waitFor(() => expect(runtime.diagnostics().presenting).toBe(true));
    const shadow = document.querySelector<HTMLElement>("[data-wts-experience]")?.shadowRoot;
    shadow?.querySelector<HTMLButtonElement>("button.primary")?.click();

    await vi.waitFor(() =>
      expect(interactions).toContainEqual(
        expect.objectContaining({ actionId: "unsafe", actionOutcome: "unhandled" }),
      ),
    );
    expect(runtime.diagnostics()).toMatchObject({
      presenting: true,
      lastErrorCode: "EXPERIENCE_ACTION_NOT_ALLOWED",
    });
  });

  it("never renders an expired cached manifest while offline", async () => {
    const trust = createTrust();
    const expired = trust.signManifest(
      manifest([campaign("expired", 1)], {
        issuedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
    );
    const storage = new MemoryStorage();
    await storage.saveExperienceManifest(toStored(expired));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    let consent: "pending" | "granted" | "denied" = "granted";
    const runtime = new ExperienceRuntime({
      sourceKey,
      collectorOrigin: "https://collect.example.test",
      timeoutMs: 500,
      debug: false,
      getConsent: () => consent,
      getIdentity: () => ({
        anonymousId: "00000000-0000-4000-8000-000000000001",
        sessionId: "00000000-0000-4000-8000-000000000002",
      }),
      getStorage: () => storage,
      rootPublicKey: trust.rootPublicKey,
    });
    runtimes.push(runtime);

    await runtime.setConsent("granted");
    runtime.evaluate(pageContext());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.diagnostics().presenting).toBe(false);
    expect(document.querySelector("[data-wts-experience]")).toBeNull();
    consent = "denied";
  });
});

function createRuntime(rootPublicKey: string): ExperienceRuntime {
  const storage = new MemoryStorage();
  return new ExperienceRuntime({
    sourceKey,
    collectorOrigin: "https://collect.example.test",
    timeoutMs: 500,
    debug: false,
    getConsent: () => "granted",
    getIdentity: () => ({
      anonymousId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
    }),
    getStorage: () => storage,
    rootPublicKey,
  });
}

function stubExperienceFetch(
  bootstrap: BootstrapResponse,
  requests: Array<Record<string, unknown>>,
  interactions: Array<Record<string, unknown>> = [],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(requestUrl).pathname;
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      requests.push({ path, ...body });
      if (path === "/experiences/v2/bootstrap") {
        return jsonResponse(bootstrap, { etag: '"manifest-7"' });
      }
      if (path === "/experiences/v2/decide") {
        return jsonResponse({
          mode: "contextual",
          decisions: [],
          serverTime: new Date().toISOString(),
        });
      }
      if (path === "/experiences/v2/interactions/batch") {
        const items = body.interactions as Array<Record<string, unknown>>;
        interactions.push(...items);
        return jsonResponse({
          accepted: items.map((item) => item.clientInteractionId),
          duplicates: [],
          rejected: [],
        });
      }
      throw new Error(`Unexpected request ${path}`);
    }),
  );
}

function createTrust() {
  const root = generateKeyPairSync("ed25519");
  const leaves = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  leaves.set("leaf-1", generateKeyPairSync("ed25519"));
  const api = {
    rootPublicKey: root.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    addLeaf(keyId: string, pair: ReturnType<typeof generateKeyPairSync>) {
      leaves.set(keyId, pair);
    },
    signManifest(
      value: ExperienceManifest,
      keyId = "leaf-1",
      privateKey = leaves.get(keyId)!.privateKey,
    ): BootstrapResponse {
      const now = Date.now();
      const keysetPayload = {
        version: 1,
        issuedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
        keys: [...leaves.entries()].map(([id, pair]) => ({
          keyId: id,
          algorithm: "Ed25519" as const,
          publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
          notBefore: new Date(now - 60_000).toISOString(),
          expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
        })),
      };
      const keysetBytes = Buffer.from(canonicalJson(keysetPayload));
      const onlineKeyset: OnlineKeyset = {
        ...keysetPayload,
        signedPayload: keysetBytes.toString("base64url"),
        rootSignature: sign(null, keysetBytes, root.privateKey).toString("base64url"),
      };
      const manifestBytes = Buffer.from(canonicalJson(value));
      return {
        onlineKeyset,
        manifest: value,
        signedPayload: manifestBytes.toString("base64url"),
        signature: sign(null, manifestBytes, privateKey).toString("base64url"),
        keyId,
        expiresAt: value.expiresAt,
      };
    },
  };
  return api;
}

function manifest(
  campaigns: ManifestCampaign[],
  times: { issuedAt?: string; expiresAt?: string } = {},
): ExperienceManifest {
  const now = Date.now();
  return {
    schemaVersion: 2,
    sourceId: "source-v2",
    sourceKey,
    manifestVersion: 7,
    environment: "production",
    generatedAt: new Date(now).toISOString(),
    issuedAt: times.issuedAt ?? new Date(now - 1_000).toISOString(),
    expiresAt: times.expiresAt ?? new Date(now + 10 * 60_000).toISOString(),
    campaigns,
  };
}

function campaign(
  id: string,
  priority: number,
  actions: Partial<ExperienceContent["translations"][string]> = {},
  contentOverrides: Partial<ExperienceContent> = {},
): ManifestCampaign {
  return {
    campaignId: id,
    campaignVersionId: `${id}-v1`,
    priority,
    startsAt: null,
    endsAt: null,
    placement: "modal",
    defaultLocale: "en",
    trigger: { type: "page_view", match: { kind: "pathname_exact", value: "/checkout" } },
    targeting: { kind: "all", conditions: [] },
    frequency: { session: 1, daily: 1 },
    variants: [
      {
        id: `${id}-variant`,
        key: "control",
        content: {
          translations: {
            en: { title: id, description: "Experience V2", ...actions },
          },
          closeable: true,
          themePreset: "light",
          delaySeconds: 0,
          autoCloseSeconds: null,
          ...contentOverrides,
        },
        asset: null,
      },
    ],
    requiresPersonalization: false,
    grant: `leaf-1.${"a".repeat(64)}.${"b".repeat(64)}`,
    assignment: {
      assignmentId: `${id}-assignment`,
      kind: "variant",
      variantId: `${id}-variant`,
    },
  };
}

function queuedExperience(overrides: Partial<QueuedExperience> = {}): QueuedExperience {
  const source = campaign("queued", 1);
  const variant = source.variants[0]!;
  return {
    campaignId: source.campaignId,
    campaignVersionId: source.campaignVersionId,
    assignmentId: source.assignment!.assignmentId,
    variantId: variant.id,
    exposureId: "00000000-0000-4000-8000-000000000020",
    placement: source.placement,
    priority: source.priority,
    content: variant.content,
    grant: source.grant!,
    defaultLocale: source.defaultLocale,
    eligibleAt: Date.now(),
    manifestExpiresAt: Date.now() + 60_000,
    frequency: source.frequency,
    ...overrides,
  };
}

function pageContext() {
  return {
    trigger: {
      type: "page_view" as const,
      match: { kind: "pathname_exact" as const, value: "/checkout" },
    },
    pathname: "/checkout",
    properties: {},
    triggerEventId: "00000000-0000-4000-8000-000000000003",
  };
}

function toStored(value: BootstrapResponse): StoredExperienceManifest {
  return {
    signedPayload: value.signedPayload,
    signature: value.signature,
    keyId: value.keyId,
    expiresAt: value.expiresAt,
    onlineKeyset: value.onlineKeyset,
    cachedAt: new Date().toISOString(),
  };
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function mutate(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}
