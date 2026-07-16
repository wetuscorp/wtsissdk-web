import { MAX_QUEUE_BYTES, MAX_QUEUE_EVENTS } from "./constants";
import { byteLength } from "./runtime";
import type { Identity, IdentityMutation, StorageAdapter, StoredState, WebEvent } from "./types";

const META_STORE = "meta";
const EVENT_STORE = "events";
const IDENTITY_STORE = "identity_mutations";

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
  private state: StoredState = { queue: [], identityQueue: [] };

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
    trimQueues(this.state);
  }

  async enqueueIdentity(mutation: IdentityMutation): Promise<void> {
    this.state.identityQueue.push(clone(mutation));
    trimQueues(this.state);
  }

  async remove(clientEventIds: ReadonlySet<string>): Promise<void> {
    this.state.queue = this.state.queue.filter((event) => !clientEventIds.has(event.clientEventId));
  }

  async removeIdentity(clientMutationIds: ReadonlySet<string>): Promise<void> {
    this.state.identityQueue = this.state.identityQueue.filter(
      (mutation) => !clientMutationIds.has(mutation.clientMutationId),
    );
  }

  async clear(): Promise<void> {
    this.state = { queue: [], identityQueue: [] };
  }

  close(): void {}
}

class IndexedDbStorage implements StorageAdapter {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(sourceKey: string): Promise<IndexedDbStorage> {
    const request = indexedDB.open(databaseName(sourceKey), 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      if (!database.objectStoreNames.contains(EVENT_STORE)) {
        database.createObjectStore(EVENT_STORE, { keyPath: "clientEventId" });
      }
      if (!database.objectStoreNames.contains(IDENTITY_STORE)) {
        database.createObjectStore(IDENTITY_STORE, { keyPath: "clientMutationId" });
      }
    };
    return new IndexedDbStorage(await requestResult(request));
  }

  async load(): Promise<StoredState> {
    const transaction = this.database.transaction(
      [META_STORE, EVENT_STORE, IDENTITY_STORE],
      "readonly",
    );
    const meta = transaction.objectStore(META_STORE);
    const events = transaction.objectStore(EVENT_STORE);
    const mutations = transaction.objectStore(IDENTITY_STORE);
    const [identity, attributionContextId, attributionContextExpiresAt, queue, identityQueue] =
      await Promise.all([
        requestResult(meta.get("identity") as IDBRequest<Identity | undefined>),
        requestResult(meta.get("attributionContextId") as IDBRequest<string | undefined>),
        requestResult(meta.get("attributionContextExpiresAt") as IDBRequest<string | undefined>),
        requestResult(events.getAll() as IDBRequest<WebEvent[]>),
        requestResult(mutations.getAll() as IDBRequest<IdentityMutation[]>),
      ]);
    await transactionDone(transaction);
    queue.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    identityQueue.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    return {
      ...(identity ? { identity } : {}),
      ...(attributionContextId && attributionContextExpiresAt
        ? { attributionContextId, attributionContextExpiresAt }
        : {}),
      queue,
      identityQueue,
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
    const existing = await this.load();
    const state = clone(existing);
    state.queue.push(event);
    trimQueues(state);
    const retainedIds = new Set(state.queue.map((item) => item.clientEventId));
    const retainedMutations = new Set(state.identityQueue.map((item) => item.clientMutationId));
    const transaction = this.database.transaction([EVENT_STORE, IDENTITY_STORE], "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    const identityStore = transaction.objectStore(IDENTITY_STORE);
    store.put(event);
    for (const queued of existing.queue) {
      if (!retainedIds.has(queued.clientEventId)) store.delete(queued.clientEventId);
    }
    for (const mutation of state.identityQueue) identityStore.put(mutation);
    for (const mutation of existing.identityQueue) {
      if (!retainedMutations.has(mutation.clientMutationId)) {
        identityStore.delete(mutation.clientMutationId);
      }
    }
    await transactionDone(transaction);
  }

  async enqueueIdentity(mutation: IdentityMutation): Promise<void> {
    const existing = await this.load();
    const state = clone(existing);
    state.identityQueue.push(mutation);
    trimQueues(state);
    const retainedEvents = new Set(state.queue.map((item) => item.clientEventId));
    const retainedMutations = new Set(state.identityQueue.map((item) => item.clientMutationId));
    const transaction = this.database.transaction([EVENT_STORE, IDENTITY_STORE], "readwrite");
    const eventStore = transaction.objectStore(EVENT_STORE);
    const identityStore = transaction.objectStore(IDENTITY_STORE);
    identityStore.put(mutation);
    for (const event of existing.queue) {
      if (!retainedEvents.has(event.clientEventId)) eventStore.delete(event.clientEventId);
    }
    for (const queued of existing.identityQueue) {
      if (!retainedMutations.has(queued.clientMutationId)) {
        identityStore.delete(queued.clientMutationId);
      }
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

  async removeIdentity(clientMutationIds: ReadonlySet<string>): Promise<void> {
    if (clientMutationIds.size === 0) return;
    const transaction = this.database.transaction(IDENTITY_STORE, "readwrite");
    const store = transaction.objectStore(IDENTITY_STORE);
    for (const id of clientMutationIds) store.delete(id);
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const transaction = this.database.transaction(
      [META_STORE, EVENT_STORE, IDENTITY_STORE],
      "readwrite",
    );
    transaction.objectStore(META_STORE).clear();
    transaction.objectStore(EVENT_STORE).clear();
    transaction.objectStore(IDENTITY_STORE).clear();
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

function trimQueues(state: StoredState): void {
  while (
    state.queue.length + state.identityQueue.length > MAX_QUEUE_EVENTS ||
    byteLength({ events: state.queue, mutations: state.identityQueue }) > MAX_QUEUE_BYTES
  ) {
    if (state.queue.length > 0) state.queue.shift();
    else state.identityQueue.shift();
  }
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
