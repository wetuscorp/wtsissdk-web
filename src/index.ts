import { WtsClientImpl } from "./client";
import type { WtsClient, WtsClientOptions } from "./types";

export type {
  ConsentState,
  EventProperties,
  AvailableExperience,
  ExperienceAction,
  ExperienceActionEvent,
  ExperienceActionHandler,
  ExperienceAvailableHandler,
  ExperienceConsentResult,
  ExperienceConsentState,
  ExperienceContent,
  ExperienceDiagnostics,
  ExperienceLocalizedContent,
  ExperienceOptions,
  ExperiencePlacement,
  ExperienceRenderMode,
  FlushResult,
  OperationResult,
  Revenue,
  ReportedAttribution,
  Scalar,
  TestSessionCheck,
  TestSessionDiagnostics,
  TestSessionExperienceDecision,
  TestSessionIdentityMethod,
  TestSessionJoinResult,
  TestSessionPairing,
  TestSessionProbeRunResult,
  TestSessionProbeResult,
  UserAttributes,
  UserAttributeValue,
  UserUpdateOperations,
  WtsClient,
  WtsClientOptions,
} from "./types";

export function createWtsClient(options: WtsClientOptions): WtsClient {
  return new WtsClientImpl(options);
}
