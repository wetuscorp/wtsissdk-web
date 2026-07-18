import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";

import { WtsClientImpl } from "../src/client";
import { renderExperience } from "../src/experiences/renderer";
import { ExperienceRuntime } from "../src/experiences/runtime";
import type { ExperienceManifest, QueuedExperience } from "../src/experiences/types";
import type {
  BatchResponse,
  Identity,
  IdentityBatchResponse,
  IdentityMutation,
  ExperienceOptions,
  ExperienceAvailableHandler,
  Transport,
  WebEvent,
} from "../src/types";

const manifestKeyPair = generateKeyPairSync("ed25519");
const manifestVerificationKeys = {
  v1: manifestKeyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
};

class AnalyticsTransport implements Transport {
  async bootstrap(input: { sourceKey: string; identity: Identity; clientEventId: string }) {
    void input;
    return { attributionContextId: null, serverTime: new Date().toISOString() };
  }

  async send(_sourceKey: string, events: WebEvent[]): Promise<BatchResponse> {
    return {
      accepted: events.map((event) => event.clientEventId),
      duplicates: [],
      rejected: [],
    };
  }

  async sendIdentity(
    _sourceKey: string,
    mutations: IdentityMutation[],
  ): Promise<IdentityBatchResponse> {
    return {
      accepted: mutations.map((mutation) => mutation.clientMutationId),
      duplicates: [],
    };
  }
}

describe("Web Experiences", () => {
  const clients: WtsClientImpl[] = [];

  beforeEach(() => {
    window.history.replaceState({}, "", "/checkout");
  });

  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("is disabled by default and does not make an Experiences request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new WtsClientImpl(
      { sourceKey: sourceKey(), consent: "granted" },
      new AnalyticsTransport(),
    );
    clients.push(client);

    await expect(client.setExperienceConsent("contextual")).resolves.toEqual({
      accepted: false,
      reason: "feature_disabled",
    });
    await client.page("Checkout");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not bootstrap before both analytics and experience consent are granted", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new WtsClientImpl(
      { sourceKey: sourceKey(), experiences: { enabled: true } },
      new AnalyticsTransport(),
    );
    clients.push(client);

    await expect(client.setExperienceConsent("contextual")).resolves.toEqual({
      accepted: false,
      reason: "analytics_consent_required",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("evaluates a contextual page campaign and exposes it in manual render mode", async () => {
    const interactions: string[] = [];
    let bootstrapTestDeviceToken = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/experiences/v1/bootstrap")) {
          bootstrapTestDeviceToken = (JSON.parse(requestBody(init)) as { testDeviceToken: string })
            .testDeviceToken;
          return jsonResponse(bootstrapFixture());
        }
        if (url.endsWith("/experiences/v1/interactions/batch")) {
          const body = JSON.parse(requestBody(init)) as {
            interactions: Array<{ clientInteractionId: string; type: string }>;
          };
          interactions.push(...body.interactions.map((item) => item.type));
          return jsonResponse({
            accepted: body.interactions.map((item) => item.clientInteractionId),
            duplicates: [],
            rejected: [],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({
          renderMode: "manual",
          allowedInternalRoutes: ["/plans"],
        }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    const available = vi.fn<ExperienceAvailableHandler>();
    client.onExperienceAvailable(available);

    await client.setExperienceConsent("contextual");
    await client.page("Checkout");
    await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(1));
    await client.flush();

    const initialPresentation = available.mock.calls[0]?.[0];
    expect(initialPresentation?.experience).toMatchObject({
      campaignId: "campaign_1",
      placement: "modal",
      content: { closeable: true },
    });
    expect(typeof initialPresentation?.handle).toBe("string");
    expect(client.getExperienceDiagnostics()).toMatchObject({
      enabled: true,
      consent: "contextual",
      renderMode: "manual",
      queued: 1,
      testDeviceToken: bootstrapTestDeviceToken,
    });
    expect(bootstrapTestDeviceToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(interactions).toEqual(
      expect.arrayContaining(["assigned_variant", "eligible", "queued"]),
    );
  });

  it("clears queued Experiences and persistent interactions when denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/experiences/v1/bootstrap")) {
          return jsonResponse(bootstrapFixture());
        }
        const body = JSON.parse(requestBody(init)) as {
          interactions: Array<{ clientInteractionId: string }>;
        };
        return jsonResponse({
          accepted: body.interactions.map((item) => item.clientInteractionId),
          duplicates: [],
          rejected: [],
        });
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    await client.setExperienceConsent("contextual");
    await client.page("Checkout");
    await client.setExperienceConsent("denied");

    expect(client.getExperienceDiagnostics()).toMatchObject({
      consent: "denied",
      queued: 0,
      presenting: false,
    });
  });

  it("offers only the queued manual head, supports idempotent lifecycle reports, and then offers next", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/experiences/v1/bootstrap")) {
          return jsonResponse(bootstrapFixture({ secondaryCampaign: true }));
        }
        if (url.endsWith("/experiences/v1/interactions/batch")) {
          const body = JSON.parse(requestBody(init)) as {
            interactions: Array<{ clientInteractionId: string }>;
          };
          return jsonResponse({
            accepted: body.interactions.map((item) => item.clientInteractionId),
            duplicates: [],
            rejected: [],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    const available = vi.fn<ExperienceAvailableHandler>();
    client.onExperienceAvailable(available);

    await client.setExperienceConsent("contextual");
    await client.page("Checkout");
    expect(available).toHaveBeenCalledTimes(1);
    const first = available.mock.calls[0]?.[0];
    expect(first).toMatchObject({
      experience: { campaignId: "campaign_1" },
    });
    expect(typeof first?.handle).toBe("string");
    expect(first?.experience).not.toHaveProperty("exposureId");
    expect(first?.experience).not.toHaveProperty("grant");
    await expect(client.presentNextExperience()).resolves.toBe(false);

    await expect(client.acknowledgeExperienceRender(first!.handle)).resolves.toEqual({
      accepted: true,
      idempotent: false,
    });
    await expect(client.acknowledgeExperienceRender(first!.handle)).resolves.toEqual({
      accepted: true,
      idempotent: true,
    });
    await expect(client.acknowledgeExperienceImpression(first!.handle)).resolves.toEqual({
      accepted: true,
      idempotent: false,
    });
    await expect(client.acknowledgeExperienceImpression(first!.handle)).resolves.toEqual({
      accepted: true,
      idempotent: true,
    });
    await expect(client.reportExperienceAction(first!.handle, "primary")).resolves.toEqual({
      accepted: true,
      idempotent: false,
    });
    await expect(client.reportExperienceAction(first!.handle, "primary")).resolves.toEqual({
      accepted: true,
      idempotent: true,
    });
    await expect(client.dismissExperience(first!.handle)).resolves.toEqual({
      accepted: true,
      idempotent: false,
    });
    await expect(client.dismissExperience(first!.handle)).resolves.toEqual({
      accepted: true,
      idempotent: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 3_050));
    expect(available).toHaveBeenCalledTimes(2);
    const second = available.mock.calls[1]?.[0];
    expect(second?.experience).toMatchObject({ campaignId: "campaign_2" });
    expect(typeof second?.handle).toBe("string");
  });

  it("offers an already queued manual head when the handler subscribes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/experiences/v1/bootstrap")) {
          return jsonResponse(bootstrapFixture());
        }
        const body = JSON.parse(requestBody(init)) as {
          interactions: Array<{ clientInteractionId: string }>;
        };
        return jsonResponse({
          accepted: body.interactions.map((item) => item.clientInteractionId),
          duplicates: [],
          rejected: [],
        });
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    await client.setExperienceConsent("contextual");
    await client.page("Checkout");

    const available = vi.fn();
    client.onExperienceAvailable(available);
    expect(available).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a manifest signature cannot be verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!requestUrl(input).endsWith("/experiences/v1/bootstrap")) {
          throw new Error("Interactions must not be sent for an untrusted manifest.");
        }
        return jsonResponse({ ...bootstrapFixture(), signature: "invalid" });
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    const available = vi.fn();
    client.onExperienceAvailable(available);

    await expect(client.setExperienceConsent("contextual")).resolves.toEqual({ accepted: true });
    await client.page("Checkout");
    expect(available).not.toHaveBeenCalled();
    expect(client.getExperienceDiagnostics().lastErrorCode).toBe(
      "EXPERIENCE_MANIFEST_SIGNATURE_INVALID",
    );
  });

  it("fails closed when bootstrap names an unpinned manifest key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!requestUrl(input).endsWith("/experiences/v1/bootstrap")) {
          throw new Error("Interactions must not be sent for an untrusted manifest.");
        }
        return jsonResponse({ ...bootstrapFixture(), keyId: "rotated_key" });
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);

    await client.setExperienceConsent("contextual");
    await client.page("Checkout");
    expect(client.getExperienceDiagnostics().lastErrorCode).toBe(
      "EXPERIENCE_MANIFEST_KEY_UNTRUSTED",
    );
  });

  it("fails closed when a validly signed manifest belongs to a different source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!requestUrl(input).endsWith("/experiences/v1/bootstrap")) {
          throw new Error("Interactions must not be sent for a cross-source manifest.");
        }
        return jsonResponse(bootstrapFixture({ sourceKey: "web_other_source_123456" }));
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    const available = vi.fn();
    client.onExperienceAvailable(available);

    await client.setExperienceConsent("contextual");
    await client.page("Checkout");

    expect(available).not.toHaveBeenCalled();
    expect(client.getExperienceDiagnostics().lastErrorCode).toBe(
      "EXPERIENCE_MANIFEST_SOURCE_MISMATCH",
    );
  });

  it("requires an explicit profile-consent signal for personalized Experiences", async () => {
    const profileConsentSignals: boolean[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/experiences/v1/bootstrap")) {
          profileConsentSignals.push(
            (JSON.parse(requestBody(init)) as { profileConsentGranted: boolean })
              .profileConsentGranted,
          );
          return jsonResponse(bootstrapFixture());
        }
        const body = JSON.parse(requestBody(init)) as {
          interactions: Array<{ clientInteractionId: string }>;
        };
        return jsonResponse({
          accepted: body.interactions.map((item) => item.clientInteractionId),
          duplicates: [],
          rejected: [],
        });
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    await client.page("Checkout");
    await expect(client.setExperienceConsent("personalized")).resolves.toEqual({
      accepted: false,
      reason: "profile_consent_required",
    });

    await client.setProfileConsent(true);
    await expect(client.setExperienceConsent("personalized")).resolves.toEqual({
      accepted: false,
      reason: "profile_identity_required",
    });
    await client.identify("customer_1842");
    await client.flush();
    await expect(client.setExperienceConsent("personalized")).resolves.toEqual({ accepted: true });
    expect(profileConsentSignals).toEqual([true]);

    await client.setProfileConsent(false);
    expect(client.getExperienceDiagnostics().consent).toBe("pending");
  });

  it("requires a collector-accepted identity binding before personalized evaluation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/experiences/v1/bootstrap")) {
          return jsonResponse(bootstrapFixture());
        }
        if (requestUrl(input).endsWith("/experiences/v1/decide")) {
          return jsonResponse({ decisions: [], serverTime: new Date().toISOString() });
        }
        const body = JSON.parse(requestBody(init)) as {
          interactions: Array<{ clientInteractionId: string }>;
        };
        return jsonResponse({
          accepted: body.interactions.map((item) => item.clientInteractionId),
          duplicates: [],
          rejected: [],
        });
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);

    await client.setProfileConsent(true);
    await expect(client.setExperienceConsent("personalized")).resolves.toEqual({
      accepted: false,
      reason: "profile_identity_required",
    });
    await client.identify("customer_1842");
    await client.flush();
    await expect(client.setExperienceConsent("personalized")).resolves.toEqual({ accepted: true });
    await client.page("Checkout");
  });

  it("consumes the two-overlay session cap at presentation, not at impression", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/experiences/v1/bootstrap")) {
          return jsonResponse(bootstrapFixture({ campaignCount: 3 }));
        }
        const body = JSON.parse(requestBody(init)) as {
          interactions: Array<{ clientInteractionId: string }>;
        };
        return jsonResponse({
          accepted: body.interactions.map((item) => item.clientInteractionId),
          duplicates: [],
          rejected: [],
        });
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "manual" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    const available = vi.fn<ExperienceAvailableHandler>();
    client.onExperienceAvailable(available);

    await client.setExperienceConsent("contextual");
    await client.page("Checkout");
    expect(available).toHaveBeenCalledTimes(1);

    const first = available.mock.calls[0]![0];
    await expect(client.acknowledgeExperienceRender(first.handle)).resolves.toMatchObject({
      accepted: true,
    });
    // No impression is reported; this still counts as a presented overlay.
    await expect(client.dismissExperience(first.handle)).resolves.toMatchObject({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 3_050));

    const second = available.mock.calls[1]![0];
    await expect(client.acknowledgeExperienceRender(second.handle)).resolves.toMatchObject({
      accepted: true,
    });
    await expect(client.dismissExperience(second.handle)).resolves.toMatchObject({
      accepted: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 3_050));

    expect(available).toHaveBeenCalledTimes(2);
    expect(client.getExperienceDiagnostics().queued).toBe(0);
  }, 10_000);

  it("rejects executable URL schemes even if a bypassed configuration tries to allow one", () => {
    const runtime = new ExperienceRuntime({
      sourceKey: sourceKey(),
      collectorOrigin: "https://collect.wts.is",
      timeoutMs: 2_000,
      debug: false,
      options: {
        enabled: true,
        renderMode: "manual",
        manifestVerificationKeys,
        allowedInternalRoutes: [],
        allowedCallbackKeys: [],
        allowedDeepLinkHosts: [],
        // Deliberately bypasses validateOptions: runtime policy must still
        // reject script and local-resource schemes from a malicious manifest.
        allowedDeepLinkSchemes: ["javascript", "data", "file"],
        allowedWebOrigins: [],
      },
      getAnalyticsConsent: () => "granted",
      getProfileConsent: () => true,
      getProfileIdentityReady: () => true,
      getIdentity: () => ({ anonymousId: "anonymous", sessionId: "session" }),
      getStorage: () => undefined,
      flushIdentity: async () => undefined,
    });
    const actionAllowed = (
      runtime as unknown as {
        isActionAllowed(action: { type: "OPEN_DEEP_LINK"; target: string }): boolean;
      }
    ).isActionAllowed.bind(runtime);

    expect(actionAllowed({ type: "OPEN_DEEP_LINK", target: "javascript:alert(1)" })).toBe(false);
    expect(actionAllowed({ type: "OPEN_DEEP_LINK", target: "data:text/html,unsafe" })).toBe(false);
    expect(actionAllowed({ type: "OPEN_DEEP_LINK", target: "file:///etc/passwd" })).toBe(false);
    runtime.destroy();
  });

  it("never invokes manual callbacks in automatic mode and aborts a delayed render on consent denial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/experiences/v1/bootstrap")) {
          return jsonResponse(bootstrapFixture({ delaySeconds: 10 }));
        }
        if (url.endsWith("/experiences/v1/interactions/batch")) {
          const body = JSON.parse(requestBody(init)) as {
            interactions: Array<{ clientInteractionId: string }>;
          };
          return jsonResponse({
            accepted: body.interactions.map((item) => item.clientInteractionId),
            duplicates: [],
            rejected: [],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const client = new WtsClientImpl(
      {
        sourceKey: sourceKey(),
        consent: "granted",
        experiences: experienceOptions({ renderMode: "automatic" }),
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    const available = vi.fn();
    client.onExperienceAvailable(available);

    await client.setExperienceConsent("contextual");
    await client.page("Checkout");
    await vi.waitFor(() => expect(document.querySelector("[data-wts-experience]")).not.toBeNull());
    expect(available).not.toHaveBeenCalled();

    await client.setExperienceConsent("denied");
    expect(document.querySelector("[data-wts-experience]")).toBeNull();
    expect(client.getExperienceDiagnostics().presenting).toBe(false);
  });

  it("renders an accessible isolated surface and verifies impressions after one second", async () => {
    vi.useFakeTimers();
    const originalAttachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element) {
      return originalAttachShadow.call(this, { mode: "open" });
    });
    vi.stubGlobal(
      "IntersectionObserver",
      class implements IntersectionObserver {
        readonly root = null;
        readonly rootMargin = "";
        readonly scrollMargin = "";
        readonly thresholds = [0, 0.5, 1];

        constructor(private readonly callback: IntersectionObserverCallback) {}

        observe(target: Element) {
          this.callback([{ intersectionRatio: 0.5, target } as IntersectionObserverEntry], this);
        }

        disconnect() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
      },
    );
    const previousFocus = document.createElement("button");
    previousFocus.textContent = "Checkout";
    document.body.append(previousFocus);
    previousFocus.focus();
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    const onImpression = vi.fn();

    await renderExperience(availableExperienceFixture(), {
      locale: "en-US",
      onAction,
      onDismiss,
      onImpression,
    });

    const host = document.querySelector<HTMLElement>("[data-wts-experience='exposure_1']");
    const root = host?.shadowRoot;
    const surface = root?.querySelector<HTMLElement>("[role='dialog']");
    expect(host).toBeTruthy();
    expect(root?.querySelector("style")?.textContent).toContain("prefers-reduced-motion");
    expect(surface).toMatchObject({ tabIndex: -1 });
    expect(surface?.getAttribute("aria-modal")).toBe("true");
    expect(root?.querySelector("h2")?.textContent).toBe("Complete your order");
    expect(root?.querySelector("p")?.textContent).toBe("Your cart is ready.");

    await vi.advanceTimersByTimeAsync(999);
    expect(onImpression).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onImpression).toHaveBeenCalledTimes(1);

    root?.querySelector<HTMLButtonElement>(".primary")?.click();
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "primary", type: "OPEN_INTERNAL_ROUTE" }),
    );

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onDismiss).toHaveBeenCalledWith("dismissed");
    expect(document.querySelector("[data-wts-experience='exposure_1']")).toBeNull();
    expect(document.activeElement).toBe(previousFocus);
  });

  it("removes a delayed renderer surface when its lifecycle signal is aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onDismiss = vi.fn();
    const pending = renderExperience(availableExperienceFixture({ delaySeconds: 5 }), {
      locale: "en",
      signal: controller.signal,
      onAction: vi.fn(),
      onDismiss,
      onImpression: vi.fn(),
    });
    expect(document.querySelector("[data-wts-experience='exposure_1']")).not.toBeNull();

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector("[data-wts-experience='exposure_1']")).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

function bootstrapFixture(
  options: {
    delaySeconds?: number;
    rawManifest?: unknown;
    secondaryCampaign?: boolean;
    campaignCount?: number;
    sourceKey?: string;
  } = {},
) {
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const manifest: ExperienceManifest = {
    schemaVersion: 1,
    sourceId: "source_1",
    sourceKey: options.sourceKey ?? sourceKey(),
    sourceManifestVersion: 7,
    generatedAt: new Date().toISOString(),
    expiresAt,
    campaigns: [
      {
        campaignId: "campaign_1",
        campaignVersionId: "version_1",
        priority: 10,
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
            id: "variant_1",
            key: "control",
            content: {
              translations: {
                en: {
                  title: "Complete your order",
                  description: "Your cart is ready.",
                  primaryAction: {
                    id: "primary",
                    label: "Continue",
                    type: "OPEN_INTERNAL_ROUTE",
                    target: "/plans",
                  },
                },
              },
              closeable: true,
              themePreset: "brand",
              delaySeconds: options.delaySeconds ?? 0,
              autoCloseSeconds: null,
            },
            asset: null,
          },
        ],
        requiresPersonalization: false,
        grant: "v1.payload.signature",
        assignment: {
          assignmentId: "assignment_1",
          kind: "variant",
          variantId: "variant_1",
        },
      },
    ],
  };
  const extraCampaigns = options.campaignCount
    ? Math.max(0, options.campaignCount - 1)
    : options.secondaryCampaign
      ? 1
      : 0;
  for (let index = 0; index < extraCampaigns; index += 1) {
    const first = manifest.campaigns[0]!;
    manifest.campaigns.push({
      ...structuredClone(first),
      campaignId: `campaign_${index + 2}`,
      campaignVersionId: `version_${index + 2}`,
      priority: 5 - index,
      assignment: {
        assignmentId: `assignment_${index + 2}`,
        kind: "variant",
        variantId: "variant_1",
      },
    });
  }
  const signedPayload = Buffer.from(JSON.stringify(manifest)).toString("base64url");
  return {
    // The raw manifest is intentionally ignored by the runtime. This keeps the
    // fixture honest about the verified payload boundary.
    manifest: options.rawManifest ?? { schemaVersion: 999 },
    signedPayload,
    signature: sign(
      null,
      Buffer.from(signedPayload, "base64url"),
      manifestKeyPair.privateKey,
    ).toString("base64url"),
    keyId: "v1",
    expiresAt,
  };
}

function experienceOptions(overrides: Partial<ExperienceOptions> = {}): ExperienceOptions {
  return {
    enabled: true,
    manifestVerificationKeys,
    ...overrides,
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  return init.body;
}

function sourceKey() {
  return "web_test_source_12345678";
}

function availableExperienceFixture(options: { delaySeconds?: number } = {}): QueuedExperience {
  return {
    campaignId: "campaign_1",
    campaignVersionId: "version_1",
    assignmentId: "assignment_1",
    exposureId: "exposure_1",
    presentationHandle: "exposure_1",
    variantId: "variant_1",
    placement: "modal",
    priority: 10,
    content: {
      translations: {
        en: {
          title: "Complete your order",
          description: "Your cart is ready.",
          primaryAction: {
            id: "primary",
            label: "Continue",
            type: "OPEN_INTERNAL_ROUTE",
            target: "/plans",
          },
        },
      },
      closeable: true,
      themePreset: "brand",
      delaySeconds: options.delaySeconds ?? 0,
      autoCloseSeconds: null,
    },
    assetUrl: "",
    grant: "v1.payload.signature",
    defaultLocale: "en",
    eligibleAt: Date.now(),
  };
}
