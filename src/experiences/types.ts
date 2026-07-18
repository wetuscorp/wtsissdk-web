import type {
  EventProperties,
  ExperienceContent,
  ExperienceContext,
  ExperiencePlacement,
  StoredExperienceInteraction,
  Scalar,
  WtsExperience,
} from "../types";

export interface ExperienceMetadata {
  platform: "web";
  sdkVersion: string;
  locale: string;
}

export interface ExperienceSettings {
  allowedInternalRoutes: string[];
  allowedCallbackKeys: string[];
  allowedDeepLinkHosts: string[];
  allowedDeepLinkSchemes: string[];
  allowedWebOrigins: string[];
}

export interface ManifestBranch {
  assignmentId: string;
  kind: "variant" | "holdout";
  variantId: string | null;
}

export interface ManifestVariant {
  id: string;
  key: string;
  content: ExperienceContent;
  asset: { url: string } | null;
}

export interface ManifestCampaign {
  campaignId: string;
  campaignVersionId: string;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
  placement: ExperiencePlacement;
  defaultLocale: string;
  trigger: ExperienceContext["trigger"];
  targeting: TargetNode;
  frequency: { session: number; daily: number };
  variants: ManifestVariant[];
  requiresPersonalization: boolean;
  grant: string | null;
  assignment: ManifestBranch | null;
}

export interface ExperienceManifest {
  schemaVersion: 1;
  sourceId: string;
  /** Public source key, signed to prevent cross-source manifest replay. */
  sourceKey: string;
  sourceManifestVersion: number;
  environment?: "production" | "staging" | "development";
  generatedAt: string;
  expiresAt: string;
  campaigns: ManifestCampaign[];
}

export interface BootstrapResponse {
  /** Ignored by the SDK. Only `signedPayload` is trusted after verification. */
  manifest: unknown;
  /** Base64url UTF-8 JSON. It must be signature-verified before parsing. */
  signedPayload: string;
  signature: string;
  /** Signing key id (the `kid` used to look up the configured public key). */
  keyId: string;
  /** Ignored by the SDK; expiry is taken from the verified payload. */
  expiresAt: string;
}

export interface ExperienceDecision {
  campaignId: string;
  campaignVersionId: string;
  assignmentId: string;
  variantId: string | null;
  holdout: boolean;
  placement: ExperiencePlacement;
  priority: number;
  content: {
    id: string;
    key: string;
    content: ExperienceContent;
    asset: { url: string } | null;
  } | null;
  grant: string;
}

export interface DecisionResponse {
  decisions: ExperienceDecision[];
  serverTime: string;
}

export type TargetNode =
  | {
      kind: "condition";
      field: "platform" | "environment" | "locale" | "source_id" | "actor_type";
      key?: string;
      operator: "equals" | "not_equals" | "in" | "not_in" | "exists" | "gt" | "gte" | "lt" | "lte";
      value?: Scalar | Scalar[];
    }
  | { kind: "all"; conditions: TargetNode[] }
  | { kind: "any"; conditions: TargetNode[] }
  | { kind: "not"; condition: TargetNode };

export interface QueuedExperience extends WtsExperience {
  /** Local opaque reference. It is the only public representation of exposureId. */
  presentationHandle: string;
  exposureId: string;
  grant: string;
  defaultLocale: string;
  eligibleAt: number;
  /** Epoch milliseconds from the verified signed manifest. Never render after this point. */
  manifestExpiresAt: number;
  triggerEventId?: string;
}

export type ExperienceInteraction = StoredExperienceInteraction;

export interface RuntimeContext {
  pathname?: string;
  pageName?: string;
  eventKey?: string;
  properties: EventProperties;
  triggerEventId?: string;
}
