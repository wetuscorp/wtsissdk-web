import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WtsClientImpl } from "../src/client";
import { renderExperience } from "../src/experiences/renderer";
import type {
  AvailableExperience,
  BatchResponse,
  Identity,
  IdentityBatchResponse,
  IdentityMutation,
  Transport,
  WebEvent,
} from "../src/types";

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
        experiences: {
          enabled: true,
          renderMode: "manual",
          allowedInternalRoutes: ["/plans"],
        },
      },
      new AnalyticsTransport(),
    );
    clients.push(client);
    const available = vi.fn();
    client.onExperienceAvailable(available);

    await client.setExperienceConsent("contextual");
    await client.page("Checkout");
    await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(1));
    await client.flush();

    expect(available.mock.calls[0]?.[0]).toMatchObject({
      campaignId: "campaign_1",
      placement: "modal",
      content: { closeable: true },
    });
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
        experiences: { enabled: true, renderMode: "manual" },
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
});

function bootstrapFixture() {
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    manifest: {
      schemaVersion: 1,
      sourceId: "source_1",
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
                delaySeconds: 0,
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
    },
    signature: "signature",
    keyId: "v1",
    expiresAt,
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
  return `web_${crypto.randomUUID().replace(/-/g, "")}`;
}

function availableExperienceFixture(): AvailableExperience {
  return {
    campaignId: "campaign_1",
    campaignVersionId: "version_1",
    assignmentId: "assignment_1",
    exposureId: "exposure_1",
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
      delaySeconds: 0,
      autoCloseSeconds: null,
    },
    assetUrl: "",
  };
}
