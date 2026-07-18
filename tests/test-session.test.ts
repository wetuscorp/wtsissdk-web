import { afterEach, describe, expect, it, vi } from "vitest";

import { WtsClientImpl } from "../src/client";
import type {
  TestSessionPlan,
  TestSessionProbeResult,
  TestSessionSignal,
  TestSessionTransport,
  Transport,
} from "../src/types";

class AnalyticsTransport implements Transport {
  async bootstrap() {
    return { attributionContextId: null, serverTime: new Date().toISOString() };
  }

  async send() {
    return { accepted: [], duplicates: [], rejected: [] };
  }

  async sendIdentity() {
    return { accepted: [], duplicates: [] };
  }
}

class FakeTestSessionTransport implements TestSessionTransport {
  readonly pairs: Array<Parameters<TestSessionTransport["pair"]>[1]> = [];
  readonly handshakes: Array<Parameters<TestSessionTransport["handshake"]>[1]> = [];
  readonly signalBatches: TestSessionSignal[][] = [];
  readonly leaves: Array<Parameters<TestSessionTransport["leave"]>[1]> = [];
  compatible = true;
  experienceOutcome: "ready" | "holdout" | "not_eligible" | "blocked" = "not_eligible";

  async pair(_sourceKey: string, input: Parameters<TestSessionTransport["pair"]>[1]) {
    this.pairs.push(input);
    return {
      session: { id: "session_123", status: "running", expiresAt: futureIso() },
      participant: {
        id: "participant_123",
        sourceId: "source_123",
        sourceType: "web_app" as const,
        status: "paired" as const,
      },
      sessionToken: "a".repeat(32),
      testProfile: { externalUserId: "test_profile_123" },
      requiredSdkVersion: "0.4.0-alpha.1",
      testPlan: testPlan(),
    };
  }

  async handshake(_sourceKey: string, input: Parameters<TestSessionTransport["handshake"]>[1]) {
    this.handshakes.push(input);
    return {
      accepted: true,
      compatible: this.compatible,
      requiredSdkVersion: "0.4.0-alpha.1",
      checks: [
        {
          key: "sdk_version",
          status: this.compatible ? ("ready" as const) : ("blocked" as const),
          code: null,
        },
      ],
      testPlan: testPlan(),
    };
  }

  async signals(_sourceKey: string, input: Parameters<TestSessionTransport["signals"]>[1]) {
    this.signalBatches.push(input.signals);
    return {
      accepted: input.signals.map((signal) => signal.clientSignalId),
      duplicates: [],
      rejected: [],
    };
  }

  async resolve() {
    return {
      match: true,
      status: "ready" as const,
      code: "RESOLVED",
      originalUrl: "https://markaniz.wts.is/kampanya",
      fallbackUrl: "https://example.com/kampanya",
      link: { id: "link_123", path: "/campaign", parameters: { source: "test" } },
    } satisfies TestSessionProbeResult;
  }

  async decideExperience() {
    return {
      outcome: this.experienceOutcome,
      reason: this.experienceOutcome === "ready" ? null : "TEST_FIXTURE_NOT_ELIGIBLE",
      testGrant:
        this.experienceOutcome === "ready"
          ? { fixtureId: "fixture_123", expiresAt: futureIso() }
          : null,
      decision:
        this.experienceOutcome === "ready"
          ? {
              campaignId: "campaign_123",
              campaignVersionId: "version_123",
              placement: "modal",
              defaultLocale: "en",
              variant: { id: "variant_123", key: "control", content: {}, asset: null },
            }
          : null,
    } as Awaited<ReturnType<TestSessionTransport["decideExperience"]>>;
  }

  async leave(_sourceKey: string, input: Parameters<TestSessionTransport["leave"]>[1]) {
    this.leaves.push(input);
    return { accepted: true };
  }
}

describe("SDK Test & Validate session", () => {
  const clients: WtsClientImpl[] = [];

  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.length = 0;
    vi.restoreAllMocks();
  });

  it("is strictly opt-in and sends only sanitized observations after pairing", async () => {
    const testTransport = new FakeTestSessionTransport();
    const client = new WtsClientImpl(
      { sourceKey: uniqueSource(), consent: "granted" },
      new AnalyticsTransport(),
      testTransport,
    );
    clients.push(client);

    await client.track(
      "checkout_started",
      { cart_total: 749.9, currency: "TRY" },
      { amount: "749.90", currency: "TRY" },
    );
    expect(testTransport.pairs).toEqual([]);
    expect(testTransport.signalBatches).toEqual([]);

    const joined = await client.joinTestSession(
      "https://markaniz.wts.is/_wts/test/pair?pairing=" + "p".repeat(32),
    );
    expect(joined).toMatchObject({ accepted: true, joined: true, compatible: true });
    expect(testTransport.pairs[0]).toMatchObject({ pairingToken: "p".repeat(32) });
    expect(testTransport.handshakes[0]?.capabilities).toEqual({
      deeplink: false,
      identity: true,
      screen: false,
      experiences: false,
      offlineQueue: true,
    });

    await client.track(
      "checkout_started",
      { cart_total: 749.9, currency: "TRY" },
      { amount: "749.90", currency: "TRY" },
    );
    await client.flush();
    await vi.waitFor(() => expect(testTransport.signalBatches.flat().length).toBeGreaterThan(0));

    const serialized = JSON.stringify(testTransport.signalBatches);
    expect(serialized).toContain("checkout_started");
    expect(serialized).toContain("cart_total");
    expect(serialized).toContain("number");
    expect(serialized).toContain('"revenue":{"present":true,"currency":"TRY"}');
    expect(serialized).not.toContain("749.9");
    expect(serialized).not.toContain("test_profile_123");
    expect(client.getTestSessionDiagnostics()).toMatchObject({ joined: true, pendingSignals: 0 });
    await expect(client.leaveTestSession()).resolves.toEqual({ accepted: true });
    expect(testTransport.leaves).toHaveLength(1);
    expect(client.getTestSessionDiagnostics()).toMatchObject({ joined: false, pendingSignals: 0 });
  });

  it("keeps an incompatible session diagnostic-only and does not emit observations", async () => {
    const testTransport = new FakeTestSessionTransport();
    testTransport.compatible = false;
    const client = new WtsClientImpl(
      { sourceKey: uniqueSource(), consent: "granted" },
      new AnalyticsTransport(),
      testTransport,
    );
    clients.push(client);

    const joined = await client.joinTestSession("A2B3C4D5E6F7G8H9");
    await client.track("checkout_started", { cart_total: 749.9 });
    await client.flush();

    expect(joined).toMatchObject({ joined: true, compatible: false });
    expect(testTransport.pairs[0]).toMatchObject({ pairingCode: "A2B3C4D5E6F7G8H9" });
    expect(client.getTestSessionDiagnostics()).toMatchObject({ joined: true, compatible: false });
    expect(testTransport.signalBatches).toEqual([]);
  });

  it("restores a persisted test session only after analytics consent is granted", async () => {
    const sourceKey = uniqueSource();
    const firstTransport = new FakeTestSessionTransport();
    const firstClient = new WtsClientImpl(
      { sourceKey, consent: "granted" },
      new AnalyticsTransport(),
      firstTransport,
    );
    clients.push(firstClient);
    await firstClient.joinTestSession("A2B3C4D5E6F7G8H9");
    firstClient.destroy();

    const restoredTransport = new FakeTestSessionTransport();
    const getItem = vi.spyOn(sessionStorage, "getItem");
    const restoredClient = new WtsClientImpl(
      { sourceKey, consent: "pending" },
      new AnalyticsTransport(),
      restoredTransport,
    );
    clients.push(restoredClient);

    expect(getItem).not.toHaveBeenCalled();
    await restoredClient.track("checkout_started", { cart_total: 749.9 });
    expect(restoredTransport.signalBatches).toEqual([]);

    await restoredClient.setConsent("granted");
    await vi.waitFor(() =>
      expect(restoredClient.getTestSessionDiagnostics()).toMatchObject({ joined: true }),
    );
    await restoredClient.track("checkout_started", { cart_total: 749.9 });
    await restoredClient.flush();
    await vi.waitFor(() =>
      expect(restoredTransport.signalBatches.flat().length).toBeGreaterThan(0),
    );
    await restoredClient.leaveTestSession();
  });

  it("runs a session-authenticated resolve probe without persisting its URL", async () => {
    const testTransport = new FakeTestSessionTransport();
    const client = new WtsClientImpl(
      { sourceKey: uniqueSource() },
      new AnalyticsTransport(),
      testTransport,
    );
    clients.push(client);

    await client.joinTestSession("A2B3C4D5E6F7G8H9");
    await expect(
      client.probeTestSessionUrl("https://markaniz.wts.is/kampanya?secret=value"),
    ).resolves.toMatchObject({
      match: true,
      code: "RESOLVED",
    });
    await client.flush();
    const serializedSignals = JSON.stringify(testTransport.signalBatches);
    expect(serializedSignals).toContain("probe_completed");
    expect(serializedSignals).not.toContain("secret=value");
  });

  it("uses the isolated Experiences decide endpoint and permits only explicit test interactions", async () => {
    const testTransport = new FakeTestSessionTransport();
    testTransport.experienceOutcome = "ready";
    const client = new WtsClientImpl(
      {
        sourceKey: uniqueSource(),
        experiences: { enabled: true, renderMode: "manual" },
      },
      new AnalyticsTransport(),
      testTransport,
    );
    clients.push(client);

    await client.joinTestSession("A2B3C4D5E6F7G8H9");
    await expect(client.runTestSessionProbes()).resolves.toMatchObject({
      accepted: true,
      emitted: ["identity", "event", "experiences"],
      skipped: ["screen"],
      experienceDecision: { outcome: "ready" },
    });
    await expect(client.reportTestSessionExperienceInteraction("impression")).resolves.toEqual({
      accepted: true,
    });
    await client.flush();

    const serializedSignals = JSON.stringify(testTransport.signalBatches);
    expect(serializedSignals).toContain("experience_impression");
    expect(serializedSignals).not.toContain("experience_decision");
    expect(serializedSignals).not.toContain("fixture_123");
  });
});

function testPlan(): TestSessionPlan {
  return {
    profile: {
      selected: true,
      available: true,
      allowedMethods: [
        "identify",
        "update_user",
        "set_once",
        "increment",
        "reported_attribution",
        "reset_identity",
      ],
    },
    events: [
      {
        eventKey: "checkout_started",
        properties: [{ key: "cart_total", type: "number", required: true }],
        revenueEnabled: true,
      },
    ],
    deepLink: { selected: true, available: true, linkId: "link_123" },
    experience: {
      selected: true,
      available: true,
      campaignId: "campaign_123",
      versionId: "version_123",
    },
    screen: null,
  };
}

function uniqueSource(): string {
  return `web_test_${Math.random().toString(36).slice(2, 12)}`;
}

function futureIso(): string {
  return new Date(Date.now() + 5 * 60_000).toISOString();
}
