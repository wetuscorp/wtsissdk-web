import { ATTRIBUTION_QUERY_KEY, MAX_BATCH_BYTES, MAX_BATCH_EVENTS, SDK_VERSION } from "./constants";
import { MultiTabLock } from "./multitab-lock";
import {
  byteLength,
  clearBrowserSession,
  createUuid,
  loadBrowserSession,
  locale,
  referrerHost,
  safeWarn,
  saveBrowserSession,
} from "./runtime";
import { installSpaTracker } from "./spa-tracker";
import { createStorage, deleteStorage, MemoryStorage } from "./storage";
import { HttpTransport, TransportError } from "./transport";
import type {
  ConsentState,
  EventProperties,
  FlushResult,
  Identity,
  IdentityMutation,
  OperationResult,
  ReportedAttribution,
  Revenue,
  StorageAdapter,
  Transport,
  UserAttributes,
  UserUpdateOperations,
  WebEvent,
  WtsClient,
  WtsClientOptions,
} from "./types";
import {
  normalizePathname,
  validateEvent,
  validateExternalUserId,
  validateOptions,
  validateReportedAttribution,
  validateUserAttributes,
  validateUserUpdate,
} from "./validation";

type ResolvedOptions = ReturnType<typeof validateOptions>;
const ATTRIBUTION_CONTEXT_TTL_MS = 7 * 24 * 60 * 60_000;

export class WtsClientImpl implements WtsClient {
  private consent: ConsentState;
  private storage: StorageAdapter | undefined;
  private identity: Identity | undefined;
  private attributionContextId: string | undefined;
  private attributionContextExpiresAt: number | undefined;
  private attributionToken: string | undefined;
  private bootstrapClientEventId = createUuid();
  private bootstrapped = false;
  private destroyed = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private enablePromise: Promise<void> | undefined;
  private removeSpaTracker: (() => void) | undefined;
  private lastPagePath: string | undefined;
  private readonly options: ResolvedOptions;
  private readonly transport: Transport;
  private readonly lock: MultiTabLock;

  constructor(options: WtsClientOptions, transport?: Transport) {
    this.options = validateOptions(options);
    this.consent = this.options.consent;
    this.transport =
      transport ?? new HttpTransport(this.options.collectorOrigin, this.options.requestTimeoutMs);
    this.lock = new MultiTabLock(`flush-${this.options.sourceKey}`);
    this.attributionToken = captureAttributionToken();
    this.installLifecycleListeners();
    if (this.consent === "granted") void this.startEnable();
    if (this.consent === "denied") this.attributionToken = undefined;
  }

  async setConsent(consent: "granted" | "denied"): Promise<void> {
    if (this.destroyed) return;
    if (consent === "denied") {
      this.consent = "denied";
      this.cancelRetry();
      const storage = this.storage;
      if (storage) {
        await this.lock.run(async () => {
          await storage.clear();
          storage.close();
        });
      }
      try {
        await deleteStorage(this.options.sourceKey);
      } catch {
        safeWarn(this.options.debug, "Stored SDK data could not be deleted because it is in use.");
      }
      this.storage = undefined;
      this.identity = undefined;
      this.attributionContextId = undefined;
      this.attributionContextExpiresAt = undefined;
      this.attributionToken = undefined;
      this.bootstrapped = false;
      clearBrowserSession(this.options.sourceKey);
      this.removeSpaTracking();
      return;
    }
    const wasGranted = this.consent === "granted";
    this.consent = "granted";
    if (!wasGranted || !this.storage) await this.startEnable();
  }

  async page(name?: string): Promise<OperationResult> {
    let unavailable = this.unavailableResult();
    if (unavailable) return unavailable;
    await this.ensureReady();
    unavailable = this.unavailableResult();
    if (unavailable) return unavailable;
    const pathname = currentPathname();
    const referrer = referrerHost();
    const event: WebEvent = {
      ...this.eventBase("page_view"),
      pathname,
      ...(name?.trim() ? { pageName: name.trim().slice(0, 120) } : {}),
      ...(referrer ? { referrerHost: referrer } : {}),
      properties: {},
    };
    await this.enqueue(event);
    this.lastPagePath = pathname;
    return { accepted: true, clientEventId: event.clientEventId };
  }

  async track(
    eventKey: string,
    properties: EventProperties = {},
    revenue?: Revenue,
  ): Promise<OperationResult> {
    let unavailable = this.unavailableResult();
    if (unavailable) return unavailable;
    await this.ensureReady();
    unavailable = this.unavailableResult();
    if (unavailable) return unavailable;
    validateEvent(eventKey, properties, revenue);
    const event: WebEvent = {
      ...this.eventBase("custom"),
      eventKey,
      properties: { ...properties },
      ...(revenue ? { revenue: { ...revenue } } : {}),
    };
    await this.enqueue(event);
    return { accepted: true, clientEventId: event.clientEventId };
  }

  async identify(
    externalUserId: string,
    attributes: UserAttributes = {},
  ): Promise<OperationResult> {
    const unavailable = await this.prepareIdentityOperation();
    if (unavailable) return unavailable;
    validateExternalUserId(externalUserId);
    validateUserAttributes(attributes);
    return this.enqueueIdentityMutation({
      type: "identify",
      externalUserId,
      ...(Object.keys(attributes).length ? { attributes: { ...attributes } } : {}),
    });
  }

  async updateUser(operations: UserUpdateOperations): Promise<OperationResult> {
    const unavailable = await this.prepareIdentityOperation();
    if (unavailable) return unavailable;
    validateUserUpdate(operations);
    return this.enqueueIdentityMutation({
      type: "update_user",
      operations: structuredCloneSafe(operations),
    });
  }

  async setReportedAttribution(attribution: ReportedAttribution): Promise<OperationResult> {
    const unavailable = await this.prepareIdentityOperation();
    if (unavailable) return unavailable;
    validateReportedAttribution(attribution);
    return this.enqueueIdentityMutation({
      type: "reported_attribution",
      attribution: { ...attribution },
    });
  }

  async resetIdentity(): Promise<OperationResult> {
    const unavailable = await this.prepareIdentityOperation();
    if (unavailable) return unavailable;
    const result = await this.enqueueIdentityMutation({ type: "reset_identity" });
    if (!this.storage) return result;
    this.identity = { anonymousId: createUuid(), sessionId: createUuid() };
    this.bootstrapClientEventId = createUuid();
    this.attributionContextId = undefined;
    this.attributionContextExpiresAt = undefined;
    this.attributionToken = undefined;
    this.bootstrapped = false;
    this.lastPagePath = undefined;
    clearBrowserSession(this.options.sourceKey);
    saveBrowserSession(this.options.sourceKey, {
      sessionId: this.identity.sessionId,
      bootstrapClientEventId: this.bootstrapClientEventId,
    });
    await this.storage.saveIdentity(this.identity);
    await this.storage.saveAttributionContext();
    return result;
  }

  async flush(): Promise<FlushResult> {
    if (this.consent !== "granted" || this.destroyed || !this.storage) {
      return { sent: 0, pending: 0 };
    }
    const result = await this.lock.run(async () => this.flushExclusive(false));
    if (result) return result;
    const state = await this.storage.load();
    return { sent: 0, pending: state.queue.length + state.identityQueue.length };
  }

  async reset(): Promise<void> {
    this.cancelRetry();
    await this.storage?.clear();
    this.identity = undefined;
    this.attributionContextId = undefined;
    this.attributionContextExpiresAt = undefined;
    this.attributionToken = undefined;
    clearBrowserSession(this.options.sourceKey);
    this.bootstrapClientEventId = createUuid();
    this.bootstrapped = false;
    this.lastPagePath = undefined;
    if (this.consent === "granted" && !this.destroyed) await this.initializeIdentity();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelRetry();
    this.removeSpaTracking();
    this.removeLifecycleListeners();
    const storage = this.storage;
    if (storage) void this.lock.run(async () => storage.close());
  }

  private async enable(): Promise<void> {
    if (this.destroyed || this.consent !== "granted") return;
    if (!this.storage) {
      try {
        this.storage = await createStorage(this.options.sourceKey);
        await this.storage.load();
      } catch {
        this.storage?.close();
        this.storage = new MemoryStorage();
        safeWarn(this.options.debug, "IndexedDB unavailable; using a memory-only event queue.");
      }
    }
    await this.initializeIdentity();
    try {
      await this.ensureBootstrapped();
    } catch (error) {
      this.handleRetryableError(error);
    }
    if (this.options.autoTrackPageViews && !this.removeSpaTracker) {
      this.removeSpaTracker = installSpaTracker(() => {
        void this.trackAutomaticPage();
      });
      await this.trackAutomaticPage();
    }
    void this.flush();
  }

  private startEnable(): Promise<void> {
    if (this.enablePromise) return this.enablePromise;
    const pending = this.enable();
    this.enablePromise = pending;
    void pending.finally(() => {
      if (this.enablePromise === pending) this.enablePromise = undefined;
    });
    return pending;
  }

  private async ensureReady(): Promise<void> {
    if (this.consent === "granted" && (!this.storage || !this.identity)) {
      await this.startEnable();
    }
  }

  private async initializeIdentity(): Promise<void> {
    if (!this.storage) return;
    const state = await this.storage.load();
    const browserSession = loadBrowserSession(this.options.sourceKey);
    this.identity = {
      anonymousId: state.identity?.anonymousId ?? createUuid(),
      sessionId: browserSession?.sessionId ?? createUuid(),
    };
    this.bootstrapClientEventId = browserSession?.bootstrapClientEventId ?? createUuid();
    saveBrowserSession(this.options.sourceKey, {
      sessionId: this.identity.sessionId,
      bootstrapClientEventId: this.bootstrapClientEventId,
    });
    const contextExpiry = state.attributionContextExpiresAt
      ? Date.parse(state.attributionContextExpiresAt)
      : Number.NaN;
    if (
      state.attributionContextId &&
      Number.isFinite(contextExpiry) &&
      contextExpiry > Date.now()
    ) {
      this.attributionContextId = state.attributionContextId;
      this.attributionContextExpiresAt = contextExpiry;
    } else if (state.attributionContextId || state.attributionContextExpiresAt) {
      await this.storage.saveAttributionContext();
    }
    if (
      !state.identity ||
      state.identity.anonymousId !== this.identity.anonymousId ||
      state.identity.sessionId !== this.identity.sessionId
    ) {
      await this.storage.saveIdentity(this.identity);
    }
  }

  private async ensureBootstrapped(): Promise<void> {
    if (this.bootstrapped || !this.identity || !this.storage) return;
    const result = await this.transport.bootstrap({
      sourceKey: this.options.sourceKey,
      identity: this.identity,
      clientEventId: this.bootstrapClientEventId,
      ...(this.attributionToken ? { attributionToken: this.attributionToken } : {}),
    });
    this.bootstrapped = true;
    this.attributionToken = undefined;
    if (result.attributionContextId) {
      this.attributionContextId = result.attributionContextId;
      const serverTime = Date.parse(result.serverTime);
      this.attributionContextExpiresAt =
        (Number.isFinite(serverTime) ? serverTime : Date.now()) + ATTRIBUTION_CONTEXT_TTL_MS;
      await this.storage.saveAttributionContext(
        result.attributionContextId,
        new Date(this.attributionContextExpiresAt).toISOString(),
      );
    }
    this.retryAttempt = 0;
  }

  private async enqueue(event: WebEvent): Promise<void> {
    if (!this.storage) return;
    await this.storage.enqueue(event);
    queueMicrotask(() => void this.flush());
  }

  private async flushExclusive(keepalive: boolean): Promise<FlushResult> {
    if (!this.storage) return { sent: 0, pending: 0 };
    if (this.retryTimer && !keepalive) {
      const state = await this.storage.load();
      return { sent: 0, pending: state.queue.length + state.identityQueue.length };
    }
    try {
      await this.ensureBootstrapped();
      const state = await this.storage.load();
      const identityBatch = takeIdentityBatch(state.identityQueue);
      if (identityBatch.length > 0) {
        try {
          const identityResponse = await this.transport.sendIdentity(
            this.options.sourceKey,
            identityBatch,
          );
          const permanentlyRejected = (identityResponse.rejected ?? [])
            .filter((item) => !item.retryable)
            .map((item) => item.clientMutationId);
          await this.storage.removeIdentity(
            new Set([
              ...identityResponse.accepted,
              ...identityResponse.duplicates,
              ...permanentlyRejected,
            ]),
          );
          if (permanentlyRejected.length > 0) {
            safeWarn(
              this.options.debug,
              `Collector permanently rejected ${permanentlyRejected.length} identity mutation(s).`,
            );
          }
        } catch (error) {
          if (error instanceof TransportError && !error.retryable) {
            await this.storage.removeIdentity(
              new Set(identityBatch.map((mutation) => mutation.clientMutationId)),
            );
            safeWarn(
              this.options.debug,
              `Collector rejected an identity mutation (${error.code ?? error.status}).`,
            );
          } else {
            this.handleRetryableError(error);
            return {
              sent: 0,
              pending: state.queue.length + state.identityQueue.length,
            };
          }
        }
      }
      const refreshedState = await this.storage.load();
      const batch = takeBatch(refreshedState.queue, this.activeAttributionContextId());
      if (batch.length === 0) {
        return {
          sent: identityBatch.length,
          pending: refreshedState.queue.length + refreshedState.identityQueue.length,
        };
      }
      const response = await this.transport.send(this.options.sourceKey, batch, keepalive);
      const remove = new Set([...response.accepted, ...response.duplicates]);
      let hasRetryableRejection = false;
      for (const rejection of response.rejected) {
        if (rejection.retryable) hasRetryableRejection = true;
        else remove.add(rejection.clientEventId);
      }
      await this.storage.remove(remove);
      const pendingState = await this.storage.load();
      const pending = pendingState.queue.length + pendingState.identityQueue.length;
      if (hasRetryableRejection) this.scheduleRetry();
      else {
        this.retryAttempt = 0;
        if (pending > 0) queueMicrotask(() => void this.flush());
      }
      return { sent: remove.size + identityBatch.length, pending };
    } catch (error) {
      this.handleRetryableError(error);
      const state = await this.storage.load();
      return { sent: 0, pending: state.queue.length + state.identityQueue.length };
    }
  }

  private handleRetryableError(error: unknown): void {
    if (error instanceof TransportError && !error.retryable) {
      safeWarn(
        this.options.debug,
        `Collector rejected the request (${error.code ?? error.status}).`,
      );
      return;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.consent !== "granted" || this.destroyed || this.retryTimer) return;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(this.retryAttempt, 6));
    const jitter = Math.floor(Math.random() * Math.max(1, base * 0.25));
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, base + jitter);
  }

  private async trackAutomaticPage(): Promise<void> {
    const pathname = currentPathname();
    if (pathname === this.lastPagePath) return;
    await this.page();
  }

  private eventBase(type: WebEvent["type"]): Omit<WebEvent, "properties"> {
    if (!this.identity) throw new Error("Web SDK identity is unavailable.");
    const attributionContextId = this.activeAttributionContextId();
    return {
      schemaVersion: 3,
      clientEventId: createUuid(),
      ...this.identity,
      type,
      occurredAt: new Date().toISOString(),
      metadata: { platform: "web", sdkVersion: SDK_VERSION, locale: locale() },
      ...(attributionContextId ? { attributionContextId } : {}),
    };
  }

  private async prepareIdentityOperation(): Promise<OperationResult | undefined> {
    let unavailable = this.unavailableResult();
    if (unavailable) return unavailable;
    await this.ensureReady();
    unavailable = this.unavailableResult();
    return unavailable;
  }

  private async enqueueIdentityMutation(
    value: Omit<
      IdentityMutation,
      "schemaVersion" | "clientMutationId" | "occurredAt" | "identity" | "metadata"
    >,
  ): Promise<OperationResult> {
    if (!this.storage || !this.identity) throw new Error("Web SDK identity is unavailable.");
    const mutation: IdentityMutation = {
      schemaVersion: 1,
      clientMutationId: createUuid(),
      occurredAt: new Date().toISOString(),
      identity: { ...this.identity },
      metadata: { platform: "web", sdkVersion: SDK_VERSION, locale: locale() },
      ...value,
    };
    await this.storage.enqueueIdentity(mutation);
    queueMicrotask(() => void this.flush());
    return { accepted: true, clientEventId: mutation.clientMutationId };
  }

  private unavailableResult(): OperationResult | undefined {
    if (this.destroyed) return { accepted: false, reason: "destroyed" };
    if (this.consent === "pending") return { accepted: false, reason: "consent_pending" };
    if (this.consent === "denied") return { accepted: false, reason: "consent_denied" };
    return undefined;
  }

  private activeAttributionContextId(): string | undefined {
    if (
      this.attributionContextId &&
      this.attributionContextExpiresAt &&
      this.attributionContextExpiresAt > Date.now()
    ) {
      return this.attributionContextId;
    }
    if (this.attributionContextId || this.attributionContextExpiresAt) {
      this.attributionContextId = undefined;
      this.attributionContextExpiresAt = undefined;
      void this.storage?.saveAttributionContext();
    }
    return undefined;
  }

  private installLifecycleListeners(): void {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private removeLifecycleListeners(): void {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private readonly onPageHide = () => {
    if (this.consent === "granted") void this.lock.run(() => this.flushExclusive(true));
  };

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden" && this.consent === "granted") {
      void this.lock.run(() => this.flushExclusive(true));
    }
  };

  private removeSpaTracking(): void {
    this.removeSpaTracker?.();
    this.removeSpaTracker = undefined;
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

function currentPathname(): string {
  return normalizePathname(typeof location === "undefined" ? "/" : location.pathname);
}

function captureAttributionToken(): string | undefined {
  if (typeof location === "undefined" || typeof history === "undefined") return undefined;
  const url = new URL(location.href);
  const token = url.searchParams.get(ATTRIBUTION_QUERY_KEY) ?? undefined;
  if (!token) return undefined;
  url.searchParams.delete(ATTRIBUTION_QUERY_KEY);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return token;
}

function takeBatch(queue: WebEvent[], attributionContextId?: string): WebEvent[] {
  const batch: WebEvent[] = [];
  for (const queued of queue.slice(0, MAX_BATCH_EVENTS)) {
    const event = attributionContextId ? { ...queued, attributionContextId } : queued;
    if (byteLength({ schemaVersion: 3, events: [...batch, event] }) > MAX_BATCH_BYTES) break;
    batch.push(event);
  }
  return batch;
}

function takeIdentityBatch(queue: IdentityMutation[]): IdentityMutation[] {
  const batch: IdentityMutation[] = [];
  for (const mutation of queue.slice(0, MAX_BATCH_EVENTS)) {
    if (byteLength({ schemaVersion: 1, mutations: [...batch, mutation] }) > MAX_BATCH_BYTES) break;
    batch.push(mutation);
  }
  return batch;
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
