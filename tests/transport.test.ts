import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpTransport } from "../src/transport";
import type { TransportError } from "../src/transport";
import type { WebEvent } from "../src/types";

describe("HttpTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses a credentials-free CORS request and preserves keepalive", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: [EVENT.clientEventId], duplicates: [], rejected: [] }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const transport = new HttpTransport("https://collect.wts.is", 2_000);

    await transport.send("web_source_key", [EVENT], true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://collect.wts.is/v2/events/batch");
    expect(request).toMatchObject({
      method: "POST",
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
      keepalive: true,
    });
    expect(new Headers(request?.headers).get("X-WTS-Source-Key")).toBe("web_source_key");
  });

  it.each([
    [429, true, "RATE_LIMITED"],
    [503, true, "SERVICE_UNAVAILABLE"],
    [400, false, "VALIDATION_ERROR"],
  ])("maps status %s to a typed retry decision", async (status, retryable, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code, message: "Request rejected." }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const transport = new HttpTransport("https://collect.wts.is", 2_000);

    await expect(transport.send("web_source_key", [EVENT], false)).rejects.toMatchObject({
      name: "WtsTransportError",
      status,
      retryable,
      code,
    } satisfies Partial<TransportError>);
  });

  it("aborts requests at the configured timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Request aborted.", "AbortError")),
        );
      });
    });
    const transport = new HttpTransport("https://collect.wts.is", 250);

    const request = transport.send("web_source_key", [EVENT], false);
    const rejection = expect(request).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
  });
});

const EVENT: WebEvent = {
  schemaVersion: 2,
  clientEventId: "00000000-0000-4000-8000-000000000001",
  anonymousId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  type: "page_view",
  occurredAt: "2026-07-16T00:00:00.000Z",
  metadata: { platform: "web", sdkVersion: "test", locale: "en" },
  pathname: "/pricing",
  properties: {},
};
