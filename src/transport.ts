import { SDK_VERSION } from "./constants";
import { locale } from "./runtime";
import type {
  BatchResponse,
  Identity,
  IdentityBatchResponse,
  IdentityMutation,
  Transport,
  TestSessionTransport,
  WebEvent,
} from "./types";

export class HttpTransport implements Transport {
  constructor(
    private readonly collectorOrigin: string,
    private readonly timeoutMs: number,
  ) {}

  async bootstrap(input: {
    sourceKey: string;
    identity: Identity;
    clientEventId: string;
    attributionToken?: string;
  }): Promise<{ attributionContextId: string | null; serverTime: string }> {
    const response = await this.post(
      "/v3/bootstrap",
      input.sourceKey,
      {
        schemaVersion: 3,
        clientEventId: input.clientEventId,
        ...input.identity,
        occurredAt: new Date().toISOString(),
        metadata: { platform: "web", sdkVersion: SDK_VERSION, locale: locale() },
        ...(input.attributionToken ? { attributionToken: input.attributionToken } : {}),
      },
      false,
    );
    return (await response.json()) as { attributionContextId: string | null; serverTime: string };
  }

  async send(sourceKey: string, events: WebEvent[], keepalive: boolean): Promise<BatchResponse> {
    const response = await this.post(
      "/v3/events/batch",
      sourceKey,
      { schemaVersion: 3, events },
      keepalive,
    );
    return (await response.json()) as BatchResponse;
  }

  async sendIdentity(
    sourceKey: string,
    mutations: IdentityMutation[],
  ): Promise<IdentityBatchResponse> {
    const response = await this.post(
      "/v3/identity/mutations",
      sourceKey,
      { schemaVersion: 1, mutations },
      false,
    );
    return (await response.json()) as IdentityBatchResponse;
  }

  private async post(
    path: string,
    sourceKey: string,
    body: unknown,
    keepalive: boolean,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.collectorOrigin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WTS-Source-Key": sourceKey },
        body: JSON.stringify(body),
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        keepalive,
        signal: controller.signal,
      });
      if (!response.ok) throw await TransportError.fromResponse(response);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class HttpTestSessionTransport implements TestSessionTransport {
  constructor(
    private readonly collectorOrigin: string,
    private readonly timeoutMs: number,
  ) {}

  async pair(sourceKey: string, input: Parameters<TestSessionTransport["pair"]>[1]) {
    return this.json<Awaited<ReturnType<TestSessionTransport["pair"]>>>(
      "/sdk/test/v2/pair",
      sourceKey,
      input,
    );
  }

  async handshake(sourceKey: string, input: Parameters<TestSessionTransport["handshake"]>[1]) {
    return this.json<Awaited<ReturnType<TestSessionTransport["handshake"]>>>(
      "/sdk/test/v2/handshake",
      sourceKey,
      input,
    );
  }

  async signals(sourceKey: string, input: Parameters<TestSessionTransport["signals"]>[1]) {
    return this.json<Awaited<ReturnType<TestSessionTransport["signals"]>>>(
      "/sdk/test/v2/signals/batch",
      sourceKey,
      input,
    );
  }

  async resolve(sourceKey: string, input: Parameters<TestSessionTransport["resolve"]>[1]) {
    return this.json<Awaited<ReturnType<TestSessionTransport["resolve"]>>>(
      "/sdk/test/v2/resolve",
      sourceKey,
      input,
    );
  }

  async decideExperience(
    sourceKey: string,
    input: Parameters<TestSessionTransport["decideExperience"]>[1],
  ) {
    return this.json<Awaited<ReturnType<TestSessionTransport["decideExperience"]>>>(
      "/sdk/test/v2/experiences/decide",
      sourceKey,
      input,
    );
  }

  async leave(sourceKey: string, input: Parameters<TestSessionTransport["leave"]>[1]) {
    return this.json<Awaited<ReturnType<TestSessionTransport["leave"]>>>(
      "/sdk/test/v2/leave",
      sourceKey,
      input,
    );
  }

  private async json<T>(path: string, sourceKey: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.collectorOrigin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WTS-Source-Key": sourceKey },
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

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WtsTransportError";
  }

  static async fromResponse(response: Response): Promise<TransportError> {
    let payload: { code?: string; message?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // The SDK intentionally does not surface response bodies in logs.
    }
    return new TransportError(
      payload.message ?? `Collector request failed with status ${response.status}.`,
      response.status,
      response.status === 429 || response.status >= 500,
      payload.code,
    );
  }
}
