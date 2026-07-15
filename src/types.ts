export type ConsentState = "pending" | "granted" | "denied";
export type Scalar = string | number | boolean;
export type EventProperties = Record<string, Scalar>;

export interface Revenue {
  amount: string;
  currency: string;
}

export interface WtsClientOptions {
  sourceKey: string;
  consent?: ConsentState;
  autoTrackPageViews?: boolean;
  collectorOrigin?: string;
  requestTimeoutMs?: number;
  debug?: boolean;
}

export interface OperationResult {
  accepted: boolean;
  reason?: "consent_pending" | "consent_denied" | "destroyed";
  clientEventId?: string;
}

export interface FlushResult {
  sent: number;
  pending: number;
}

export interface WtsClient {
  setConsent(consent: "granted" | "denied"): Promise<void>;
  page(name?: string): Promise<OperationResult>;
  track(
    eventKey: string,
    properties?: EventProperties,
    revenue?: Revenue,
  ): Promise<OperationResult>;
  flush(): Promise<FlushResult>;
  reset(): Promise<void>;
  destroy(): void;
}

export interface WebEvent {
  schemaVersion: 2;
  clientEventId: string;
  anonymousId: string;
  sessionId: string;
  type: "page_view" | "custom";
  eventKey?: string;
  occurredAt: string;
  metadata: {
    platform: "web";
    sdkVersion: string;
    locale: string;
  };
  pathname?: string;
  pageName?: string;
  referrerHost?: string;
  properties: EventProperties;
  revenue?: Revenue;
  attributionContextId?: string;
}

export interface Identity {
  anonymousId: string;
  sessionId: string;
}

export interface StoredState {
  identity?: Identity;
  attributionContextId?: string;
  attributionContextExpiresAt?: string;
  queue: WebEvent[];
}

export interface StorageAdapter {
  load(): Promise<StoredState>;
  saveIdentity(identity: Identity): Promise<void>;
  saveAttributionContext(value?: string, expiresAt?: string): Promise<void>;
  enqueue(event: WebEvent): Promise<void>;
  remove(clientEventIds: ReadonlySet<string>): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export interface Transport {
  bootstrap(input: {
    sourceKey: string;
    identity: Identity;
    clientEventId: string;
    attributionToken?: string;
  }): Promise<{ attributionContextId: string | null; serverTime: string }>;
  send(sourceKey: string, events: WebEvent[], keepalive: boolean): Promise<BatchResponse>;
}

export interface BatchResponse {
  accepted: string[];
  duplicates: string[];
  rejected: Array<{
    clientEventId: string;
    code: string;
    message: string;
    retryable: boolean;
  }>;
}
