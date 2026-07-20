import type { Identity } from "../types";
import { TransportError } from "../transport";
import type {
  BootstrapFetchResult,
  BootstrapResponse,
  DecisionResponse,
  ExperienceInteraction,
  ExperienceMetadata,
  RuntimeContext,
} from "./types";

export class ExperienceTransport {
  constructor(
    private readonly collectorOrigin: string,
    private readonly timeoutMs: number,
    private readonly sourceKey: string,
  ) {}

  async bootstrap(input: {
    identity: Identity;
    metadata: ExperienceMetadata;
    testDeviceToken: string;
    etag?: string;
  }): Promise<BootstrapFetchResult> {
    const response = await this.request(
      "/experiences/v2/bootstrap",
      {
        schemaVersion: 2,
        actorId: input.identity.anonymousId,
        sessionId: input.identity.sessionId,
        metadata: input.metadata,
        testDeviceToken: input.testDeviceToken,
      },
      input.etag,
    );
    const etag = response.headers.get("etag") ?? undefined;
    if (response.status === 304) return { notModified: true, ...(etag ? { etag } : {}) };
    if (!response.ok) throw await TransportError.fromResponse(response);
    return {
      notModified: false,
      response: (await response.json()) as BootstrapResponse,
      ...(etag ? { etag } : {}),
    };
  }

  decide(input: {
    identity: Identity;
    metadata: ExperienceMetadata;
    testDeviceToken: string;
    candidateVersionIds: string[];
    context: RuntimeContext & { trigger: unknown };
  }): Promise<DecisionResponse> {
    return this.post("/experiences/v2/decide", {
      schemaVersion: 2,
      actorId: input.identity.anonymousId,
      sessionId: input.identity.sessionId,
      metadata: input.metadata,
      testDeviceToken: input.testDeviceToken,
      candidateVersionIds: input.candidateVersionIds,
      context: input.context,
    });
  }

  sendInteractions(input: { identity: Identity; interactions: ExperienceInteraction[] }): Promise<{
    accepted: string[];
    duplicates: string[];
    rejected: Array<{
      clientInteractionId: string;
      code: string;
      message: string;
      retryable: boolean;
    }>;
  }> {
    return this.post("/experiences/v2/interactions/batch", {
      schemaVersion: 2,
      actorId: input.identity.anonymousId,
      sessionId: input.identity.sessionId,
      interactions: input.interactions,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, body);
    if (!response.ok) throw await TransportError.fromResponse(response);
    return (await response.json()) as T;
  }

  private async request(path: string, body: unknown, etag?: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.collectorOrigin}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WTS-Source-Key": this.sourceKey,
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        body: JSON.stringify(body),
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
