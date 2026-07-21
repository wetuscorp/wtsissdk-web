export function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) throw new Error("A secure random number generator is required.");
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function locale(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language || "en";
}

export function referrerHost(): string | undefined {
  if (typeof document === "undefined" || !document.referrer) return undefined;
  try {
    return new URL(document.referrer).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export function safeWarn(enabled: boolean, message: string): void {
  if (enabled && typeof console !== "undefined") console.warn(`[wts.is] ${message}`);
}

export type BrowserSessionState = {
  sessionId: string;
  bootstrapClientEventId: string;
};

export function loadBrowserSession(sourceKey: string): BrowserSessionState | undefined {
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(sessionKey(sourceKey)) ?? "null") as {
      sessionId?: unknown;
      bootstrapClientEventId?: unknown;
    } | null;
    return parsed && isUuid(parsed.sessionId) && isUuid(parsed.bootstrapClientEventId)
      ? {
          sessionId: parsed.sessionId,
          bootstrapClientEventId: parsed.bootstrapClientEventId,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveBrowserSession(sourceKey: string, state: BrowserSessionState): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(sessionKey(sourceKey), JSON.stringify(state));
  } catch {
    // Storage restrictions are handled by the SDK's memory-only fallback.
  }
}

export function clearBrowserSession(sourceKey: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(sessionKey(sourceKey));
  } catch {
    // A blocked browser storage API is equivalent to an already cleared session.
  }
}

function sessionKey(sourceKey: string): string {
  return `wts-session-v0.5-${sourceKey}`;
}

export function clearLegacyBrowserSession(sourceKey: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(`wts-session-${sourceKey}`);
    sessionStorage.removeItem(`wts-test-session-v1-${sourceKey}`);
  } catch {
    // Cleanup is best effort when browser storage is restricted.
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
