export type ConsentState = "pending" | "granted" | "denied";
export type Scalar = string | number | boolean;
export type EventProperties = Record<string, Scalar>;
export type UserAttributeValue = Scalar | string[] | Date;
export type UserAttributes = Record<string, UserAttributeValue>;

export interface Revenue {
  amount: string;
  currency: string;
}

export interface WtsClientOptions {
  sourceKey: string;
  autoTrackPageViews?: boolean;
  collectorOrigin?: string;
  requestTimeoutMs?: number;
  debug?: boolean;
}

export type ExperiencePlacement =
  "modal" | "top_banner" | "bottom_banner" | "slide_in" | "bottom_sheet";

export type ExperienceActionType =
  | "DISMISS"
  | "OPEN_INTERNAL_ROUTE"
  | "OPEN_DEEP_LINK"
  | "OPEN_WEB_URL"
  | "COPY_CODE"
  | "CUSTOM_CALLBACK";

export interface ExperienceAction {
  id: string;
  label: string;
  type: ExperienceActionType;
  target?: string;
}

export interface ExperienceLocalizedContent {
  title: string;
  description: string;
  primaryAction?: ExperienceAction;
  secondaryAction?: ExperienceAction;
}

/**
 * Semantic colour tokens accepted by the automatic web renderer.
 *
 * These are identifiers, not CSS values. Unknown values from a future
 * manifest are ignored safely and the selected theme preset remains in use.
 */
export type ExperienceBackgroundToken = "surface" | "subtle" | "inverse" | "brand";
export type ExperienceTextToken = "primary" | "muted" | "inverse";
export type ExperienceAccentToken = "primary" | "secondary" | "success" | "warning" | "danger";
/** Preserves forward compatibility with newer server-issued semantic tokens. */
export type ExperienceBackgroundTokenValue = ExperienceBackgroundToken | (string & {});
/** Preserves forward compatibility with newer server-issued semantic tokens. */
export type ExperienceTextTokenValue = ExperienceTextToken | (string & {});
/** Preserves forward compatibility with newer server-issued semantic tokens. */
export type ExperienceAccentTokenValue = ExperienceAccentToken | (string & {});

export interface ExperienceContent {
  translations: Record<string, ExperienceLocalizedContent>;
  closeable: boolean;
  themePreset: "light" | "dark" | "brand";
  /** A safe semantic token applied as the automatic renderer background. */
  backgroundToken?: ExperienceBackgroundTokenValue;
  /** A safe semantic token applied as the automatic renderer text colour. */
  textToken?: ExperienceTextTokenValue;
  /** A safe semantic token applied as the automatic renderer primary-action accent. */
  accentToken?: ExperienceAccentTokenValue;
  delaySeconds: number;
  autoCloseSeconds: number | null;
}

/**
 * Content and delivery metadata for an Experience that the SDK has accepted.
 *
 * This object intentionally excludes the exposure identifier. Manual renderers
 * receive that identifier only through the opaque presentation handle.
 */
export interface WtsExperience {
  campaignId: string;
  campaignVersionId: string;
  assignmentId: string | null;
  variantId: string | null;
  placement: ExperiencePlacement;
  priority: number;
  content: ExperienceContent;
  assetUrl?: string;
}

export interface ExperienceActionEvent {
  experience: WtsExperience;
  action: ExperienceAction;
}

export interface ExperienceDiagnostics {
  enabled: boolean;
  consent: ConsentState;
  decisionMode: "contextual" | "personalized" | null;
  manifestVersion: number | null;
  manifestExpiresAt: string | null;
  queued: number;
  presenting: boolean;
  sessionImpressions: number;
  testDeviceToken: string;
  lastErrorCode: string | null;
}

export type ExperienceActionHandler = (
  event: ExperienceActionEvent,
) => void | boolean | Promise<void | boolean>;

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
  getConsentState(): ConsentState;
  page(name?: string): Promise<OperationResult>;
  track(
    eventKey: string,
    properties?: EventProperties,
    revenue?: Revenue,
  ): Promise<OperationResult>;
  identify(externalUserId: string, attributes?: UserAttributes): Promise<OperationResult>;
  updateUser(operations: UserUpdateOperations): Promise<OperationResult>;
  setReportedAttribution(attribution: ReportedAttribution): Promise<OperationResult>;
  resetIdentity(): Promise<OperationResult>;
  onExperienceAction(handler: ExperienceActionHandler): () => void;
  /** Emergency host control; normal presentation is always automatic. */
  dismissCurrentExperience(): Promise<boolean>;
  getExperienceDiagnostics(): ExperienceDiagnostics;
  joinTestSession(pairing: TestSessionPairing): Promise<TestSessionJoinResult>;
  leaveTestSession(): Promise<{ accepted: boolean }>;
  probeTestSessionUrl(url: string): Promise<TestSessionProbeResult>;
  runTestSessionProbes(): Promise<TestSessionProbeRunResult>;
  reportTestSessionExperienceInteraction(
    interaction: "impression" | "action",
  ): Promise<{ accepted: boolean }>;
  getTestSessionDiagnostics(): TestSessionDiagnostics;
  flush(): Promise<FlushResult>;
  reset(): Promise<void>;
  destroy(): void;
}

export type TestSessionPairing = string | { pairingToken?: string; pairingCode?: string };

export interface TestSessionCheck {
  key: string;
  status: "ready" | "warning" | "blocked";
  code?: string | null;
  message?: string;
}

export type TestSessionIdentityMethod =
  "identify" | "update_user" | "set_once" | "increment" | "reported_attribution" | "reset_identity";

export interface TestSessionPlan {
  profile: {
    selected: boolean;
    available: boolean;
    allowedMethods: TestSessionIdentityMethod[];
  } | null;
  events: Array<{
    eventKey: string;
    properties: Array<{
      key: string;
      type: "string" | "number" | "boolean" | "date" | "string_array";
      required: boolean;
    }>;
    revenueEnabled: boolean;
  }>;
  deepLink: { selected: boolean; available: boolean; linkId: string | null } | null;
  experience: {
    selected: boolean;
    available: boolean;
    campaignId: string | null;
    versionId: string | null;
  } | null;
  screen: { selected: true } | null;
}

export interface TestSessionJoinResult {
  accepted: boolean;
  joined: boolean;
  compatible: boolean;
  requiredSdkVersion?: string;
  checks: TestSessionCheck[];
  sessionId?: string;
  expiresAt?: string;
  testProfileExternalUserId?: string;
  errorCode?: string;
}

export interface TestSessionDiagnostics {
  joined: boolean;
  compatible: boolean;
  sessionId?: string;
  expiresAt?: string;
  requiredSdkVersion?: string;
  checks: TestSessionCheck[];
  pendingSignals: number;
  lastErrorCode?: string;
}

export interface TestSessionProbeResult {
  match: boolean;
  status: "ready" | "blocked";
  code: string;
  originalUrl: string;
  fallbackUrl: string;
  link: {
    id: string;
    path: string;
    parameters: Record<string, Scalar>;
  } | null;
}

export type TestSessionExperienceContext =
  | {
      type: "page_view";
      pathname: string;
      pageName?: string;
      locale: string;
    }
  | {
      type: "screen_view";
      screenName: string;
      locale: string;
    }
  | {
      type: "custom_event";
      eventKey: string;
      properties?: EventProperties;
      locale: string;
    };

export interface TestSessionExperienceDecision {
  outcome: "ready" | "holdout" | "not_eligible" | "blocked";
  reason: string | null;
  renderMode: "automatic";
  queue: "isolated_test";
  testGrant: { fixtureId: string; expiresAt: string } | null;
  decision: {
    campaignId: string;
    campaignVersionId: string;
    placement: string;
    defaultLocale: string;
    variant: {
      id: string;
      key: string;
      content: unknown;
      asset: { url: string } | null;
    } | null;
  } | null;
}

export interface TestSessionProbeRunResult {
  accepted: boolean;
  emitted: Array<"identity" | "event" | "screen" | "experiences">;
  skipped: Array<"identity" | "event" | "screen" | "experiences">;
  pendingSignals: number;
  /** An isolated test-only decision rendered outside the production queue. */
  experienceDecision?: TestSessionExperienceDecision;
}

export interface TestSessionSignal {
  clientSignalId: string;
  type:
    | "sdk_connected"
    | "consent"
    | "deep_link_resolved"
    | "event_recorded"
    | "identity_recorded"
    | "screen_recorded"
    | "experience_impression"
    | "experience_action"
    | "probe_completed"
    | "sdk_left";
  outcome: "passed" | "failed" | "observed" | "blocked";
  occurredAt: string;
  method?: string;
  eventKey?: string;
  screenName?: string;
  propertyKeys?: string[];
  propertyTypes?: Record<string, "string" | "number" | "boolean" | "date" | "string_array">;
  /** A descriptor only; no monetary value is ever sent through test telemetry. */
  revenue?: { present: true; currency: string };
  resultCode?: string;
  feature?: string;
}

export interface TestSessionTransport {
  pair(
    sourceKey: string,
    input: {
      schemaVersion: 2;
      pairingToken?: string;
      pairingCode?: string;
      metadata: TestSessionMetadata;
    },
  ): Promise<{
    session: { id: string; status: string; expiresAt: string };
    participant: {
      id: string;
      sourceId: string;
      sourceType: "mobile_app" | "web_app";
      status: "paired";
    };
    sessionToken: string;
    testProfile: { externalUserId: string };
    requiredSdkVersion: string;
    testPlan: TestSessionPlan;
  }>;
  handshake(
    sourceKey: string,
    input: {
      schemaVersion: 2;
      participantId: string;
      sessionToken: string;
      metadata: TestSessionMetadata;
      capabilities: {
        deeplink: boolean;
        identity: boolean;
        screen: boolean;
        experiences: boolean;
        offlineQueue: boolean;
      };
      consent: ConsentState;
    },
  ): Promise<{
    accepted: boolean;
    compatible: boolean;
    requiredSdkVersion: string;
    checks: TestSessionCheck[];
    testPlan: TestSessionPlan;
  }>;
  signals(
    sourceKey: string,
    input: {
      schemaVersion: 2;
      participantId: string;
      sessionToken: string;
      signals: TestSessionSignal[];
    },
  ): Promise<{
    accepted: string[];
    duplicates: string[];
    rejected: Array<{ clientSignalId: string; code: string; message: string; retryable: boolean }>;
  }>;
  resolve(
    sourceKey: string,
    input: { schemaVersion: 2; participantId: string; sessionToken: string; url: string },
  ): Promise<TestSessionProbeResult>;
  decideExperience(
    sourceKey: string,
    input: {
      schemaVersion: 2;
      participantId: string;
      sessionToken: string;
      context: TestSessionExperienceContext;
    },
  ): Promise<TestSessionExperienceDecision>;
  leave(
    sourceKey: string,
    input: { schemaVersion: 2; participantId: string; sessionToken: string },
  ): Promise<{ accepted: boolean }>;
}

export interface TestSessionMetadata {
  platform: "web" | "ios" | "android";
  sdkFamily: "web" | "swift" | "android" | "flutter" | "react_native";
  sdkVersion: string;
  appVersion?: string;
  osVersion?: string;
  locale: string;
}

export interface ExperienceContext {
  trigger:
    | {
        type: "page_view";
        match:
          | { kind: "pathname_exact"; value: string }
          | { kind: "pathname_prefix"; value: string }
          | { kind: "page_name_exact"; value: string };
      }
    | { type: "custom_event"; eventKey: string; conditions: ExperiencePropertyCondition[] };
  pathname?: string;
  pageName?: string;
  eventKey?: string;
  properties: EventProperties;
  triggerEventId?: string;
}

export interface ExperiencePropertyCondition {
  key: string;
  operator: "equals" | "not_equals" | "in" | "not_in" | "exists" | "gt" | "gte" | "lt" | "lte";
  value?: Scalar | Scalar[];
}

export interface WebEvent {
  schemaVersion: 3;
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

export interface UserUpdateOperations {
  set?: UserAttributes;
  setOnce?: UserAttributes;
  unset?: string[];
  increment?: Record<string, number>;
}

export interface ReportedAttribution {
  source: string;
  medium?: string;
  campaign?: string;
  externalRef?: string;
}

export interface IdentityMutation {
  schemaVersion: 1;
  clientMutationId: string;
  occurredAt: string;
  identity: Identity;
  type: "identify" | "update_user" | "reported_attribution" | "reset_identity";
  externalUserId?: string;
  attributes?: UserAttributes;
  operations?: UserUpdateOperations;
  attribution?: ReportedAttribution;
  metadata: {
    platform: "web";
    sdkVersion: string;
    locale: string;
  };
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
  identityQueue: IdentityMutation[];
  experienceQueue: StoredExperienceInteraction[];
  experienceManifest?: StoredExperienceManifest;
  experienceImpressions?: Record<string, string[]>;
}

export interface StoredExperienceManifest {
  signedPayload: string;
  signature: string;
  keyId: string;
  expiresAt: string;
  etag?: string;
  cachedAt: string;
  onlineKeyset: {
    version: number;
    issuedAt: string;
    expiresAt: string;
    keys: Array<{
      keyId: string;
      algorithm: "Ed25519";
      publicKey: string;
      notBefore: string;
      expiresAt: string;
    }>;
    signedPayload: string;
    rootSignature: string;
  };
}

export interface StoredExperienceInteraction {
  clientInteractionId: string;
  grant: string;
  campaignId: string;
  campaignVersionId: string;
  assignmentId: string | null;
  variantId: string | null;
  exposureId: string | null;
  type:
    | "assigned_variant"
    | "assigned_holdout"
    | "eligible"
    | "queued"
    | "render_started"
    | "render_succeeded"
    | "render_failed"
    | "impression"
    | "primary_action"
    | "secondary_action"
    | "dismissed"
    | "auto_closed";
  actionId: string | null;
  actionOutcome: "handled" | "unhandled" | null;
  triggerEventId: string | null;
  occurredAt: string;
  metadata: {
    platform: "web";
    sdkVersion: string;
    locale: string;
  };
  failureCode: string | null;
}

export interface StorageAdapter {
  load(): Promise<StoredState>;
  saveIdentity(identity: Identity): Promise<void>;
  saveAttributionContext(value?: string, expiresAt?: string): Promise<void>;
  enqueue(event: WebEvent): Promise<void>;
  enqueueIdentity(mutation: IdentityMutation): Promise<void>;
  enqueueExperience(interaction: StoredExperienceInteraction): Promise<void>;
  saveExperienceManifest(manifest?: StoredExperienceManifest): Promise<void>;
  recordExperienceImpression(campaignVersionId: string, occurredAt: string): Promise<void>;
  remove(clientEventIds: ReadonlySet<string>): Promise<void>;
  removeIdentity(clientMutationIds: ReadonlySet<string>): Promise<void>;
  removeExperiences(clientInteractionIds: ReadonlySet<string>): Promise<void>;
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
  sendIdentity(sourceKey: string, mutations: IdentityMutation[]): Promise<IdentityBatchResponse>;
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

export interface IdentityBatchResponse {
  accepted: string[];
  duplicates: string[];
  rejected?: Array<{
    clientMutationId: string;
    code: string;
    message: string;
    retryable: boolean;
  }>;
}
