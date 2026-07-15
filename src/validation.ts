import type { EventProperties, Revenue, WtsClientOptions } from "./types";

const eventKeyPattern = /^[a-z][a-z0-9_]{1,63}$/;
const sourceKeyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const currencyPattern = /^[A-Z]{3}$/;
const amountPattern = /^-?\d{1,12}(?:\.\d{1,6})?$/;

export function validateOptions(
  options: WtsClientOptions,
): Required<
  Pick<
    WtsClientOptions,
    "sourceKey" | "autoTrackPageViews" | "collectorOrigin" | "requestTimeoutMs" | "debug"
  >
> & { consent: NonNullable<WtsClientOptions["consent"]> } {
  if (!sourceKeyPattern.test(options.sourceKey)) {
    throw new TypeError("sourceKey must be a valid wts.is Web App source key.");
  }
  const collector = new URL(options.collectorOrigin ?? "https://collect.wts.is");
  if (collector.protocol !== "https:" && !isLocalhost(collector.hostname)) {
    throw new TypeError("collectorOrigin must use HTTPS outside localhost.");
  }
  if (collector.pathname !== "/" || collector.search || collector.hash) {
    throw new TypeError("collectorOrigin must not include a path, query, or fragment.");
  }
  const timeout = options.requestTimeoutMs ?? 2_000;
  if (!Number.isInteger(timeout) || timeout < 250 || timeout > 30_000) {
    throw new TypeError("requestTimeoutMs must be an integer between 250 and 30000.");
  }
  return {
    sourceKey: options.sourceKey,
    consent: options.consent ?? "pending",
    autoTrackPageViews: options.autoTrackPageViews ?? false,
    collectorOrigin: collector.origin,
    requestTimeoutMs: timeout,
    debug: options.debug ?? false,
  };
}

export function validateEvent(
  eventKey: string,
  properties: EventProperties,
  revenue?: Revenue,
): void {
  if (!eventKeyPattern.test(eventKey)) {
    throw new TypeError("eventKey must match ^[a-z][a-z0-9_]{1,63}$.");
  }
  const entries = Object.entries(properties);
  if (entries.length > 20) throw new TypeError("Events can contain at most 20 properties.");
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new TypeError(`Invalid property key: ${key}`);
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new TypeError(`Property ${key} must be a string, number, or boolean.`);
    }
    if (typeof value === "string" && value.length > 512) {
      throw new TypeError(`Property ${key} cannot exceed 512 characters.`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`Property ${key} must be finite.`);
    }
  }
  if (revenue && (!amountPattern.test(revenue.amount) || !currencyPattern.test(revenue.currency))) {
    throw new TypeError("Revenue requires a decimal amount and uppercase ISO-4217 currency.");
  }
}

export function normalizePathname(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new TypeError("Page pathname cannot include a query or fragment.");
  }
  if (normalized.length > 2_048)
    throw new TypeError("Page pathname cannot exceed 2048 characters.");
  return normalized;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
