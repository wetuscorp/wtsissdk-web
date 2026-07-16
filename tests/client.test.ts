import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WtsClientImpl } from "../src/client";
import { createStorage } from "../src/storage";
import type {
  BatchResponse,
  Identity,
  IdentityBatchResponse,
  IdentityMutation,
  Transport,
  WebEvent,
} from "../src/types";

class FakeTransport implements Transport {
  readonly bootstraps: Array<{
    sourceKey: string;
    identity: Identity;
    clientEventId: string;
    attributionToken?: string;
  }> = [];
  readonly batches: WebEvent[][] = [];
  readonly identityBatches: IdentityMutation[][] = [];
  attributionContextId: string | null = null;
  serverTime = new Date().toISOString();
  batchResponse: ((events: WebEvent[]) => BatchResponse) | undefined;

  async bootstrap(input: {
    sourceKey: string;
    identity: Identity;
    clientEventId: string;
    attributionToken?: string;
  }): Promise<{ attributionContextId: string | null; serverTime: string }> {
    this.bootstraps.push(input);
    return { attributionContextId: this.attributionContextId, serverTime: this.serverTime };
  }

  async send(_sourceKey: string, events: WebEvent[], _keepalive: boolean): Promise<BatchResponse> {
    void _keepalive;
    this.batches.push(events);
    return (
      this.batchResponse?.(events) ?? {
        accepted: events.map((event) => event.clientEventId),
        duplicates: [],
        rejected: [],
      }
    );
  }

  async sendIdentity(
    _sourceKey: string,
    mutations: IdentityMutation[],
  ): Promise<IdentityBatchResponse> {
    this.identityBatches.push(mutations);
    return {
      accepted: mutations.map((mutation) => mutation.clientMutationId),
      duplicates: [],
    };
  }
}

describe("WtsClient", () => {
  const clients: WtsClientImpl[] = [];

  beforeEach(() => {
    window.history.replaceState({}, "", "/pricing?campaign=summer#plans");
  });

  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.length = 0;
    vi.restoreAllMocks();
  });

  it("does not initialize storage, queue, or network while consent is pending", async () => {
    const transport = new FakeTransport();
    const client = new WtsClientImpl({ sourceKey: uniqueSource() }, transport);
    clients.push(client);

    await expect(client.page("Pricing")).resolves.toEqual({
      accepted: false,
      reason: "consent_pending",
    });
    await expect(client.track("purchase", { plan: "enterprise" })).resolves.toEqual({
      accepted: false,
      reason: "consent_pending",
    });
    expect(transport.bootstraps).toHaveLength(0);
    expect(transport.batches).toHaveLength(0);
  });

  it("is ready for an immediate page call when consent is granted in options", async () => {
    const transport = new FakeTransport();
    const client = new WtsClientImpl({ sourceKey: uniqueSource(), consent: "granted" }, transport);
    clients.push(client);

    await expect(client.page("Pricing")).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(transport.batches).toHaveLength(1));
  });

  it("reuses session and bootstrap idempotency identity across full-page client reloads", async () => {
    const sourceKey = uniqueSource();
    const firstTransport = new FakeTransport();
    const first = new WtsClientImpl({ sourceKey }, firstTransport);
    clients.push(first);
    await first.setConsent("granted");
    first.destroy();

    const secondTransport = new FakeTransport();
    const second = new WtsClientImpl({ sourceKey }, secondTransport);
    clients.push(second);
    await second.setConsent("granted");

    expect(secondTransport.bootstraps[0]).toMatchObject({
      clientEventId: firstTransport.bootstraps[0]?.clientEventId,
      identity: { sessionId: firstTransport.bootstraps[0]?.identity.sessionId },
    });
  });

  it("bootstraps after consent and sends page and custom events without URL query data", async () => {
    const transport = new FakeTransport();
    const client = new WtsClientImpl({ sourceKey: uniqueSource() }, transport);
    clients.push(client);

    await client.setConsent("granted");
    await client.page("Pricing");
    await client.track(
      "purchase",
      { plan: "enterprise", seats: 42, annual: true },
      { amount: "1490.50", currency: "TRY" },
    );
    await client.flush();

    expect(transport.bootstraps).toHaveLength(1);
    await vi.waitFor(() =>
      expect(transport.batches.flat().map((event) => event.type)).toEqual(
        expect.arrayContaining(["page_view", "custom"]),
      ),
    );
    const sent = transport.batches.flat();
    expect(sent.map((event) => event.type)).toEqual(
      expect.arrayContaining(["page_view", "custom"]),
    );
    const page = sent.find((event) => event.type === "page_view");
    expect(page?.pathname).toBe("/pricing");
    expect(JSON.stringify(sent)).not.toContain("campaign=summer");
    expect(JSON.stringify(sent)).not.toContain("#plans");
  });

  it("removes the signed attribution token and forwards it only during bootstrap", async () => {
    window.history.replaceState({}, "", "/pricing?campaign=summer&_wts=signed-token-value#plans");
    const transport = new FakeTransport();
    transport.attributionContextId = "context_12345678";
    const client = new WtsClientImpl({ sourceKey: uniqueSource() }, transport);
    clients.push(client);

    expect(window.location.search).toBe("?campaign=summer");
    expect(window.location.hash).toBe("#plans");
    await client.setConsent("granted");
    await client.page();
    await client.flush();

    expect(transport.bootstraps[0]?.attributionToken).toBe("signed-token-value");
    expect(transport.batches.flat()[0]?.attributionContextId).toBe("context_12345678");
  });

  it("stops attaching an attribution context after its seven-day lifetime", async () => {
    const transport = new FakeTransport();
    transport.attributionContextId = "context_12345678";
    transport.serverTime = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const client = new WtsClientImpl({ sourceKey: uniqueSource() }, transport);
    clients.push(client);

    await client.setConsent("granted");
    await client.page();
    await client.flush();

    expect(transport.batches.flat()[0]?.attributionContextId).toBeUndefined();
  });

  it("clears SDK state and stops collection when consent is denied", async () => {
    const transport = new FakeTransport();
    const client = new WtsClientImpl({ sourceKey: uniqueSource() }, transport);
    clients.push(client);

    await client.setConsent("granted");
    await client.setConsent("denied");
    await expect(client.track("purchase")).resolves.toEqual({
      accepted: false,
      reason: "consent_denied",
    });
  });

  it("flushes identify and user updates before subsequent product events", async () => {
    const transport = new FakeTransport();
    const client = new WtsClientImpl({ sourceKey: uniqueSource() }, transport);
    clients.push(client);
    await client.setConsent("granted");

    await client.identify("customer_1842", {
      plan: "enterprise",
      country: "TR",
      subscribed: true,
    });
    await client.updateUser({
      set: { plan: "business" },
      setOnce: { signup_channel: "partner" },
      increment: { lifetime_orders: 1 },
    });
    await client.track("purchase");
    await client.flush();

    expect(transport.identityBatches.flat().map((mutation) => mutation.type)).toEqual([
      "identify",
      "update_user",
    ]);
    expect(transport.batches.flat().some((event) => event.eventKey === "purchase")).toBe(true);
  });

  it("resets the profile binding and rotates browser identity", async () => {
    const transport = new FakeTransport();
    const client = new WtsClientImpl({ sourceKey: uniqueSource() }, transport);
    clients.push(client);
    await client.setConsent("granted");
    const before = transport.bootstraps[0]?.identity.anonymousId;

    await expect(client.resetIdentity()).resolves.toMatchObject({ accepted: true });
    await client.page();
    await client.flush();

    const identityMutations = transport.identityBatches.flat();
    expect(identityMutations[identityMutations.length - 1]?.type).toBe("reset_identity");
    expect(transport.bootstraps[transport.bootstraps.length - 1]?.identity.anonymousId).not.toBe(
      before,
    );
  });

  it("deletes persisted SDK state when consent is denied before storage is opened", async () => {
    const sourceKey = uniqueSource();
    const previousStorage = await createStorage(sourceKey);
    await previousStorage.saveIdentity({
      anonymousId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
    });
    previousStorage.close();

    const client = new WtsClientImpl({ sourceKey, consent: "pending" }, new FakeTransport());
    clients.push(client);
    await client.setConsent("denied");

    const reopened = await createStorage(sourceKey);
    await expect(reopened.load()).resolves.toEqual({ queue: [], identityQueue: [] });
    reopened.close();
  });

  it("removes permanent rejections but retains retryable events", async () => {
    const transport = new FakeTransport();
    transport.batchResponse = (events) => ({
      accepted: [],
      duplicates: [],
      rejected: events.map((event) => ({
        clientEventId: event.clientEventId,
        code: event.eventKey === "retry_event" ? "SERVICE_UNAVAILABLE" : "EVENT_REJECTED",
        message: "Rejected for test.",
        retryable: event.eventKey === "retry_event",
      })),
    });
    const client = new WtsClientImpl({ sourceKey: uniqueSource() }, transport);
    clients.push(client);
    await client.setConsent("granted");

    await client.track("permanent_event");
    await vi.waitFor(() => expect(transport.batches).toHaveLength(1));
    expect(await client.flush()).toEqual({ sent: 0, pending: 0 });

    await client.track("retry_event");
    await vi.waitFor(() => expect(transport.batches).toHaveLength(2));
    expect(await client.flush()).toEqual({ sent: 0, pending: 1 });
  });

  it("deduplicates automatic SPA page views by pathname and restores history listeners", async () => {
    const transport = new FakeTransport();
    const originalPush = window.history.pushState;
    const client = new WtsClientImpl(
      { sourceKey: uniqueSource(), consent: "pending", autoTrackPageViews: true },
      transport,
    );
    clients.push(client);
    await client.setConsent("granted");
    window.history.pushState({}, "", "/pricing?step=1");
    window.history.pushState({}, "", "/pricing?step=2");
    await vi.waitFor(() => {
      expect(transport.batches.flat().filter((event) => event.type === "page_view")).toHaveLength(
        1,
      );
    });
    client.destroy();
    expect(window.history.pushState).toBe(originalPush);
  });
});

function uniqueSource(): string {
  return `web_test_${Math.random().toString(36).slice(2, 12)}`;
}
