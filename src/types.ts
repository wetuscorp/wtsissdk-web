export type ConsentState = "pending" | "granted" | "denied";
export type ExperienceConsentState = "pending" | "contextual" | "personalized" | "denied";
export type ExperienceRenderMode = "automatic" | "manual";
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
  consent?: ConsentState;
  autoTrackPageViews?: boolean;
  collectorOrigin?: string;
  requestTimeoutMs?: number;
  debug?: boolean;
  experiences?: ExperienceOptions;
}

export interface ExperienceOptions {
  enabled: boolean;
  renderMode?: ExperienceRenderMode;
  allowedInternalRoutes?: string[];
  allowedCallbackKeys?: string[];
  allowedDeepLinkHosts?: string[];
  allowedDeepLinkSchemes?: string[];
  allowedWebOrigins?: string[];
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

export interface ExperienceContent {
  translations: Record<string, ExperienceLocalizedContent>;
  closeable: boolean;
  themePreset: "light" | "dark" | "brand";
  backgroundToken?: string;
  textToken?: string;
  accentToken?: string;
  delaySeconds: number;
  autoCloseSeconds: number | null;
}

export interface AvailableExperience {
  campaignId: string;
  campaignVersionId: string;
  assignmentId: string | null;
  variantId: string | null;
  exposureId: string;
  placement: ExperiencePlacement;
  priority: number;
  content: ExperienceContent;
  assetUrl?: string;
}

export interface ExperienceActionEvent {
  experience: AvailableExperience;
  action: ExperienceAction;
  handled: boolean;
}

export interface ExperienceDiagnostics {
  enabled: boolean;
  consent: ExperienceConsentState;
  renderMode: ExperienceRenderMode;
  manifestVersion: number | null;
  manifestExpiresAt: string | null;
  queued: number;
  presenting: boolean;
  sessionImpressions: number;
  testDeviceToken: string;
  lastErrorCode: string | null;
}

export interface ExperienceConsentResult {
  accepted: boolean;
  reason?:
    "feature_disabled" | "analytics_consent_required" | "profile_consent_required" | "destroyed";
}

export type ExperienceActionHandler = (
  event: ExperienceActionEvent,
) => void | boolean | Promise<void | boolean>;
export type ExperienceAvailableHandler = (experience: AvailableExperience) => void;

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
  identify(externalUserId: string, attributes?: UserAttributes): Promise<OperationResult>;
  updateUser(operations: UserUpdateOperations): Promise<OperationResult>;
  setReportedAttribution(attribution: ReportedAttribution): Promise<OperationResult>;
  resetIdentity(): Promise<OperationResult>;
  setExperienceConsent(consent: ExperienceConsentState): Promise<ExperienceConsentResult>;
  onExperienceAction(handler: ExperienceActionHandler): () => void;
  onExperienceAvailable(handler: ExperienceAvailableHandler): () => void;
  presentNextExperience(): Promise<boolean>;
  dismissCurrentExperience(): Promise<boolean>;
  getExperienceDiagnostics(): ExperienceDiagnostics;
  flush(): Promise<FlushResult>;
  reset(): Promise<void>;
  destroy(): void;
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
