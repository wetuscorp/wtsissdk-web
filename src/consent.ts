import type { ConsentState } from "./types";

const CONSENT_PREFIX = "wts-web-v0.5-consent-";

/** The only durable state the SDK may access before consent is granted. */
export function loadConsentState(sourceKey: string): ConsentState {
  if (typeof localStorage === "undefined") return "pending";
  try {
    const value = localStorage.getItem(`${CONSENT_PREFIX}${sourceKey}`);
    return value === "granted" || value === "denied" ? value : "pending";
  } catch {
    return "pending";
  }
}

export function persistConsentState(sourceKey: string, state: "granted" | "denied"): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${CONSENT_PREFIX}${sourceKey}`, state);
  } catch {
    // The in-memory decision still applies for this client lifetime.
  }
}
