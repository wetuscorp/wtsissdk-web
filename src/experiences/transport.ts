import type { ExperienceConsentState, Identity } from "../types";
import { TransportError } from "../transport";
import type {
  BootstrapResponse,
  DecisionResponse,
  ExperienceInteraction,
  ExperienceMetadata,
  ExperienceSettings,
  RuntimeContext,
} from "./types";

type ActiveConsent = Extract<ExperienceConsentState, "contextual" | "personalized">;

export class ExperienceTransport {
  constructor(
    private readonly collectorOrigin: string,
    private readonly timeoutMs: number,
    private readonly sourceKey: string,
  ) {}

  bootstrap(input: {
    consent: ActiveConsent;
    profileConsentGranted: boolean;
    identity: Identity;
    metadata: ExperienceMetadata;
    settings: ExperienceSettings;
    testDeviceToken: string;
  }): Promise<BootstrapResponse> {
    return this.post("/experiences/v1/bootstrap", {
      schemaVersion: 1,
      consent: input.consent,
      profileConsentGranted: input.profileConsentGranted,
      actorId: input.identity.anonymousId,
      sessionId: input.identity.sessionId,
      metadata: input.metadata,
      settings: input.settings,
      testDeviceToken: input.testDeviceToken,
    });
  }

  decide(input: {
    consent: ActiveConsent;
    profileConsentGranted: boolean;
    identity: Identity;
    metadata: ExperienceMetadata;
    settings: ExperienceSettings;
    testDeviceToken: string;
    candidateVersionIds: string[];
    context: RuntimeContext & { trigger: unknown };
  }): Promise<DecisionResponse> {
    return this.post("/experiences/v1/decide", {
      schemaVersion: 1,
      consent: input.consent,
      profileConsentGranted: input.profileConsentGranted,
      actorId: input.identity.anonymousId,
      sessionId: input.identity.sessionId,
      metadata: input.metadata,
      settings: input.settings,
      testDeviceToken: input.testDeviceToken,
      candidateVersionIds: input.candidateVersionIds,
      context: input.context,
    });
  }

  sendInteractions(input: {
    consent: ActiveConsent;
    profileConsentGranted: boolean;
    identity: Identity;
    interactions: ExperienceInteraction[];
  }): Promise<{
    accepted: string[];
    duplicates: string[];
    rejected: Array<{
      clientInteractionId: string;
      code: string;
      message: string;
      retryable: boolean;
    }>;
  }> {
    return this.post("/experiences/v1/interactions/batch", {
      schemaVersion: 1,
      consent: input.consent,
      profileConsentGranted: input.profileConsentGranted,
      actorId: input.identity.anonymousId,
      sessionId: input.identity.sessionId,
      interactions: input.interactions,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.collectorOrigin}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WTS-Source-Key": this.sourceKey,
        },
        body: JSON.stringify(body),
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw await TransportError.fromResponse(response);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
