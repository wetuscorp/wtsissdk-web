import type {
  EventProperties,
  ExperienceContent,
  ExperienceContext,
  ExperiencePlacement,
  Scalar,
  StoredExperienceInteraction,
  StoredExperienceManifest,
  WtsExperience,
} from "../types";

export interface ExperienceMetadata {
  platform: "web";
  sdkVersion: string;
  locale: string;
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
  schemaVersion: 2;
  sourceId: string;
  sourceKey: string;
  manifestVersion: number;
  environment?: "production" | "staging" | "development";
  generatedAt: string;
  issuedAt: string;
  expiresAt: string;
  campaigns: ManifestCampaign[];
}

export type OnlineKeyset = StoredExperienceManifest["onlineKeyset"];

export interface BootstrapResponse {
  onlineKeyset: OnlineKeyset;
  manifest: unknown;
  signedPayload: string;
  signature: string;
  keyId: string;
  expiresAt: string;
}

export type BootstrapFetchResult =
  | { notModified: true; etag?: string }
  | { notModified: false; response: BootstrapResponse; etag?: string };

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
  mode: "contextual" | "personalized";
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
  exposureId: string;
  grant: string;
  defaultLocale: string;
  eligibleAt: number;
  /** Epoch milliseconds from the verified signed manifest. Never render after this point. */
  manifestExpiresAt: number;
  frequency: { session: number; daily: number };
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
