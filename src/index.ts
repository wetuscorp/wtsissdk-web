import { WtsClientImpl } from "./client";
import type { WtsClient, WtsClientOptions } from "./types";

export type {
  ConsentState,
  EventProperties,
  ExperienceAction,
  ExperienceActionEvent,
  ExperienceActionHandler,
  ExperienceAccentToken,
  ExperienceAccentTokenValue,
  ExperienceBackgroundToken,
  ExperienceBackgroundTokenValue,
  ExperienceContent,
  ExperienceDiagnostics,
  ExperienceLocalizedContent,
  ExperiencePlacement,
  ExperienceTextToken,
  ExperienceTextTokenValue,
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
  WtsExperience,
} from "./types";

export function createWtsClient(options: WtsClientOptions): WtsClient {
  return new WtsClientImpl(options);
}
