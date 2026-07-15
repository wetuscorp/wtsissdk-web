import { MAX_QUEUE_BYTES, MAX_QUEUE_EVENTS } from "./constants";
import { byteLength } from "./runtime";
import type { Identity, StorageAdapter, StoredState, WebEvent } from "./types";

const META_STORE = "meta";
const EVENT_STORE = "events";

export async function createStorage(sourceKey: string): Promise<StorageAdapter> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable.");
  return IndexedDbStorage.open(sourceKey);
}

export async function deleteStorage(sourceKey: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const request = indexedDB.deleteDatabase(databaseName(sourceKey));
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB deletion failed."));
    request.onblocked = () => reject(new Error("IndexedDB deletion was blocked by another tab."));
  });
}

export class MemoryStorage implements StorageAdapter {
  private state: StoredState = { queue: [] };

  async load(): Promise<StoredState> {
    return clone(this.state);
  }

  async saveIdentity(identity: Identity): Promise<void> {
    this.state.identity = { ...identity };
  }

  async saveAttributionContext(value?: string, expiresAt?: string): Promise<void> {
    if (value && expiresAt) {
      this.state.attributionContextId = value;
      this.state.attributionContextExpiresAt = expiresAt;
    } else {
      delete this.state.attributionContextId;
      delete this.state.attributionContextExpiresAt;
    }
  }

  async enqueue(event: WebEvent): Promise<void> {
    this.state.queue.push(clone(event));
    trimQueue(this.state.queue);
  }

  async remove(clientEventIds: ReadonlySet<string>): Promise<void> {
    this.state.queue = this.state.queue.filter((event) => !clientEventIds.has(event.clientEventId));
  }

  async clear(): Promise<void> {
    this.state = { queue: [] };
  }

  close(): void {}
}

class IndexedDbStorage implements StorageAdapter {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(sourceKey: string): Promise<IndexedDbStorage> {
    const request = indexedDB.open(databaseName(sourceKey), 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      if (!database.objectStoreNames.contains(EVENT_STORE)) {
        database.createObjectStore(EVENT_STORE, { keyPath: "clientEventId" });
      }
    };
    return new IndexedDbStorage(await requestResult(request));
  }

  async load(): Promise<StoredState> {
    const transaction = this.database.transaction([META_STORE, EVENT_STORE], "readonly");
    const meta = transaction.objectStore(META_STORE);
    const events = transaction.objectStore(EVENT_STORE);
    const [identity, attributionContextId, attributionContextExpiresAt, queue] = await Promise.all([
      requestResult(meta.get("identity") as IDBRequest<Identity | undefined>),
      requestResult(meta.get("attributionContextId") as IDBRequest<string | undefined>),
      requestResult(meta.get("attributionContextExpiresAt") as IDBRequest<string | undefined>),
      requestResult(events.getAll() as IDBRequest<WebEvent[]>),
    ]);
    await transactionDone(transaction);
    queue.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    return {
      ...(identity ? { identity } : {}),
      ...(attributionContextId && attributionContextExpiresAt
        ? { attributionContextId, attributionContextExpiresAt }
        : {}),
      queue,
    };
  }

  async saveIdentity(identity: Identity): Promise<void> {
    await this.writeMeta("identity", identity);
  }

  async saveAttributionContext(value?: string, expiresAt?: string): Promise<void> {
    const transaction = this.database.transaction(META_STORE, "readwrite");
    const store = transaction.objectStore(META_STORE);
    if (value && expiresAt) {
      store.put(value, "attributionContextId");
      store.put(expiresAt, "attributionContextExpiresAt");
    } else {
      store.delete("attributionContextId");
      store.delete("attributionContextExpiresAt");
    }
    await transactionDone(transaction);
  }

  async enqueue(event: WebEvent): Promise<void> {
    const state = await this.load();
    const queue = [...state.queue, event];
    trimQueue(queue);
    const retainedIds = new Set(queue.map((item) => item.clientEventId));
    const transaction = this.database.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    store.put(event);
    for (const queued of state.queue) {
      if (!retainedIds.has(queued.clientEventId)) store.delete(queued.clientEventId);
    }
    await transactionDone(transaction);
  }

  async remove(clientEventIds: ReadonlySet<string>): Promise<void> {
    if (clientEventIds.size === 0) return;
    const transaction = this.database.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    for (const id of clientEventIds) store.delete(id);
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const transaction = this.database.transaction([META_STORE, EVENT_STORE], "readwrite");
    transaction.objectStore(META_STORE).clear();
    transaction.objectStore(EVENT_STORE).clear();
    await transactionDone(transaction);
  }

  close(): void {
    this.database.close();
  }

  private async writeMeta(key: string, value: unknown): Promise<void> {
    const transaction = this.database.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).put(value, key);
    await transactionDone(transaction);
  }
}

function trimQueue(queue: WebEvent[]): void {
  while (queue.length > MAX_QUEUE_EVENTS || byteLength(queue) > MAX_QUEUE_BYTES) queue.shift();
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function databaseName(sourceKey: string): string {
  return `wts-web-${sourceKey}`;
}
