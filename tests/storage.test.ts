import { describe, expect, it } from "vitest";

import { MAX_QUEUE_EVENTS } from "../src/constants";
import { createStorage, deleteStorage, MemoryStorage } from "../src/storage";
import type { WebEvent } from "../src/types";

describe("MemoryStorage", () => {
  it("keeps a bounded FIFO queue and removes acknowledged events", async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < MAX_QUEUE_EVENTS + 5; index += 1) {
      await storage.enqueue(event(index));
    }
    const queued = (await storage.load()).queue;
    expect(queued).toHaveLength(MAX_QUEUE_EVENTS);
    expect(queued[0]?.clientEventId).toBe(uuid(5));
    await storage.remove(new Set([uuid(5), uuid(6)]));
    expect((await storage.load()).queue[0]?.clientEventId).toBe(uuid(7));
  });
});

describe("IndexedDbStorage", () => {
  it("physically removes events evicted by the shared queue limit", async () => {
    const sourceKey = `web_storage_${Math.random().toString(36).slice(2, 12)}`;
    const storage = await createStorage(sourceKey);
    try {
      for (let index = 0; index < MAX_QUEUE_EVENTS + 5; index += 1) {
        await storage.enqueue(event(index));
      }
      const queued = (await storage.load()).queue;
      expect(queued).toHaveLength(MAX_QUEUE_EVENTS);
      expect(queued[0]?.clientEventId).toBe(uuid(5));
    } finally {
      storage.close();
      await deleteStorage(sourceKey);
    }
  });
});

function event(index: number): WebEvent {
  return {
    schemaVersion: 3,
    clientEventId: uuid(index),
    anonymousId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    type: "page_view",
    occurredAt: new Date(index).toISOString(),
    metadata: { platform: "web", sdkVersion: "test", locale: "en" },
    pathname: "/",
    properties: {},
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
