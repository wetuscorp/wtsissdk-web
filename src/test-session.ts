import { SDK_VERSION } from "./constants";
import { createUuid, locale, safeWarn } from "./runtime";
import { testSessionStorageKey } from "./test-session-presence";
import { HttpTestSessionTransport, TransportError } from "./transport";
import type {
  ConsentState,
  EventProperties,
  Revenue,
  TestSessionCheck,
  TestSessionDiagnostics,
  TestSessionExperienceDecision,
  TestSessionJoinResult,
  TestSessionPairing,
  TestSessionProbeRunResult,
  TestSessionProbeResult,
  TestSessionPlan,
  TestSessionIdentityMethod,
  TestSessionSignal,
  TestSessionTransport,
} from "./types";

const MAX_PENDING_SIGNALS = 50;
const RETRY_MAX_DELAY_MS = 60_000;
type ActiveSession = {
  sessionId: string;
  participantId: string;
  sessionToken: string;
  expiresAt: string;
  compatible: boolean;
  requiredSdkVersion: string;
  checks: TestSessionCheck[];
  testPlan: TestSessionPlan;
  testExperienceDecisionReady?: boolean;
};

type PersistedTestSession = {
  version: 2;
  active: ActiveSession;
  pendingSignals: TestSessionSignal[];
};

export interface TestSessionRuntimeInput {
  sourceKey: string;
  collectorOrigin: string;
  timeoutMs: number;
  debug: boolean;
  getConsent: () => ConsentState;
  experiencesEnabled: () => boolean;
  presentTestExperience?: (
    decision: TestSessionExperienceDecision,
    onInteraction: (interaction: "impression" | "action") => void,
  ) => Promise<boolean>;
  transport?: TestSessionTransport;
}

export class TestSessionRuntime {
  private active: ActiveSession | undefined;
  private pendingSignals: TestSessionSignal[] = [];
  private lastErrorCode: string | undefined;
  private flushing: Promise<void> | undefined;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly input: TestSessionRuntimeInput) {
    const restored = loadPersistedTestSession(input.sourceKey);
    if (!restored) return;
    if (isExpired(restored.active.expiresAt)) {
      clearPersistedTestSession(input.sourceKey);
      return;
    }
    this.active = restored.active;
    this.pendingSignals = restored.pendingSignals.slice(0, MAX_PENDING_SIGNALS);
    if (this.active.compatible && this.pendingSignals.length > 0) void this.flush();
  }

  async join(pairing: TestSessionPairing): Promise<TestSessionJoinResult> {
    const credential = parsePairing(pairing);
    const transport = this.transport();
    try {
      const paired = await transport.pair(this.input.sourceKey, {
        schemaVersion: 2,
        ...credential,
        metadata: this.metadata(),
      });
      const handshake = await transport.handshake(this.input.sourceKey, {
        schemaVersion: 2,
        participantId: paired.participant.id,
        sessionToken: paired.sessionToken,
        metadata: this.metadata(),
        capabilities: this.capabilities(),
        consent: this.consent(),
      });
      this.active = {
        sessionId: paired.session.id,
        participantId: paired.participant.id,
        sessionToken: paired.sessionToken,
        expiresAt: paired.session.expiresAt,
        compatible: handshake.accepted && handshake.compatible,
        requiredSdkVersion: handshake.requiredSdkVersion,
        checks: handshake.checks.map((check) => ({ ...check })),
        testPlan: handshake.testPlan,
      };
      this.lastErrorCode = undefined;
      this.persist();
      if (this.active.compatible) {
        this.record({ type: "sdk_connected", outcome: "passed", feature: "sdk_test_session" });
      }
      return {
        accepted: handshake.accepted,
        joined: true,
        compatible: this.active.compatible,
        requiredSdkVersion: handshake.requiredSdkVersion,
        checks: this.active.checks.map((check) => ({ ...check })),
        sessionId: paired.session.id,
        expiresAt: paired.session.expiresAt,
        testProfileExternalUserId: paired.testProfile.externalUserId,
      };
    } catch (error) {
      this.clear();
      this.lastErrorCode = errorCode(error);
      return {
        accepted: false,
        joined: false,
        compatible: false,
        checks: [],
        errorCode: this.lastErrorCode,
      };
    }
  }

  async leave(): Promise<{ accepted: boolean }> {
    const active = this.active;
    if (!active) return { accepted: true };
    if (active.compatible) {
      this.record({ type: "sdk_left", outcome: "observed", feature: "sdk_test_session" });
      await this.flush();
    }
    try {
      const result = await this.transport().leave(this.input.sourceKey, {
        schemaVersion: 2,
        participantId: active.participantId,
        sessionToken: active.sessionToken,
      });
      if (result.accepted) this.clear();
      return result;
    } catch (error) {
      this.lastErrorCode = errorCode(error);
      this.persist();
      return { accepted: false };
    }
  }

  async probe(url: string): Promise<TestSessionProbeResult> {
    const active = this.requireActive();
    validateProbeUrl(url);
    try {
      const result = await this.transport().resolve(this.input.sourceKey, {
        schemaVersion: 2,
        participantId: active.participantId,
        sessionToken: active.sessionToken,
        url,
      });
      this.record({
        type: "probe_completed",
        outcome: result.match ? "passed" : "blocked",
        method: "resolve",
        resultCode: result.code,
        feature: "deeplink",
      });
      return result;
    } catch (error) {
      this.lastErrorCode = errorCode(error);
      this.record({
        type: "probe_completed",
        outcome: "failed",
        method: "resolve",
        resultCode: this.lastErrorCode,
        feature: "deeplink",
      });
      throw error;
    }
  }

  diagnostics(): TestSessionDiagnostics {
    this.expireIfNeeded();
    const active = this.active;
    return {
      joined: Boolean(active),
      compatible: active?.compatible ?? false,
      ...(active ? { sessionId: active.sessionId, expiresAt: active.expiresAt } : {}),
      ...(active ? { requiredSdkVersion: active.requiredSdkVersion } : {}),
      checks: active?.checks.map((check) => ({ ...check })) ?? [],
      pendingSignals: this.pendingSignals.length,
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
    };
  }

  observeEvent(eventKey: string, _properties: EventProperties, revenue?: Revenue): void {
    const descriptor = this.active?.testPlan.events.find((event) => event.eventKey === eventKey);
    if (!descriptor) return;
    this.record({
      type: "event_recorded",
      outcome: "observed",
      eventKey,
      ...describePlanProperties(descriptor.properties),
      ...(revenue && descriptor.revenueEnabled
        ? { revenue: { present: true, currency: revenue.currency } as const }
        : {}),
    });
  }

  observeIdentity(method: TestSessionIdentityMethod): void {
    const profile = this.active?.testPlan.profile;
    if (!profile?.selected || !profile.available || !profile.allowedMethods.includes(method))
      return;
    this.record({ type: "identity_recorded", outcome: "observed", method });
  }

  observeConsent(): void {
    this.record({ type: "consent", outcome: "observed", feature: "analytics" });
  }

  observeExperienceInteraction(
    type:
      | "assigned_variant"
      | "assigned_holdout"
      | "eligible"
      | "queued"
      | "render_started"
      | "render_succeeded"
      | "render_failed"
      | "impression"
      | "primary_action"
      | "secondary_action"
      | "dismissed"
      | "auto_closed",
  ): void {
    // Production Experience interactions belong to the production protocol.
    // Test sessions use the isolated decision endpoint and must never mirror
    // normal runtime assignments or interactions into test observations.
    void type;
  }

  async runProbes(): Promise<TestSessionProbeRunResult> {
    const active = this.requireActive();
    const emitted: TestSessionProbeRunResult["emitted"] = [];
    const skipped: TestSessionProbeRunResult["skipped"] = [];
    let experienceDecision: TestSessionExperienceDecision | undefined;
    const profile = active.testPlan.profile;
    const identityMethods = profile?.selected && profile.available ? profile.allowedMethods : [];
    if (identityMethods.length > 0) {
      for (const method of identityMethods) {
        this.record({
          type: "identity_recorded",
          outcome: "passed",
          method,
          feature: "identity",
          ...(method === "increment" ? incrementProbeDescriptor() : {}),
        });
      }
      emitted.push("identity");
    } else {
      skipped.push("identity");
    }
    const event = active.testPlan.events[0];
    if (event) {
      this.record({
        type: "event_recorded",
        outcome: "passed",
        eventKey: event.eventKey,
        propertyKeys: event.properties.map((property) => property.key),
        propertyTypes: Object.fromEntries(
          event.properties.map((property) => [property.key, property.type]),
        ),
        ...(event.revenueEnabled ? { revenue: { present: true, currency: "USD" } as const } : {}),
        feature: "events",
      });
      emitted.push("event");
    } else {
      skipped.push("event");
    }
    if (this.capabilities().screen && active.testPlan.screen?.selected) {
      this.record({
        type: "screen_recorded",
        outcome: "passed",
        screenName: "sdk_test_screen",
        feature: "screen",
      });
      emitted.push("screen");
    } else {
      skipped.push("screen");
    }
    const experience = active.testPlan.experience;
    if (!this.capabilities().experiences || !experience?.selected || !experience.available) {
      skipped.push("experiences");
    } else {
      try {
        const decision = await this.transport().decideExperience(this.input.sourceKey, {
          schemaVersion: 2,
          participantId: active.participantId,
          sessionToken: active.sessionToken,
          context: {
            type: "page_view",
            pathname: "/sdk-test",
            pageName: "SDK Test",
            locale: locale(),
          },
        });
        experienceDecision = decision;
        if (decision.outcome === "ready") {
          this.active = { ...active, testExperienceDecisionReady: true };
          this.persist();
          const presented = await this.input.presentTestExperience?.(decision, (interaction) => {
            this.record({
              type: interaction === "impression" ? "experience_impression" : "experience_action",
              outcome: "observed",
              feature: "experiences",
            });
          });
          if (presented === false) skipped.push("experiences");
          else emitted.push("experiences");
        } else {
          skipped.push("experiences");
        }
      } catch (error) {
        this.lastErrorCode = errorCode(error);
        skipped.push("experiences");
      }
    }
    await this.flush();
    return {
      accepted: Boolean(active.compatible),
      emitted,
      skipped,
      pendingSignals: this.pendingSignals.length,
      ...(experienceDecision ? { experienceDecision } : {}),
    };
  }

  async reportExperienceInteraction(
    interaction: "impression" | "action",
  ): Promise<{ accepted: boolean }> {
    const active = this.requireActive();
    if (!active.testExperienceDecisionReady) return { accepted: false };
    this.record({
      type: interaction === "impression" ? "experience_impression" : "experience_action",
      outcome: "observed",
      feature: "experiences",
    });
    await this.flush();
    return { accepted: true };
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.expireIfNeeded();
    const active = this.active;
    if (!active?.compatible || this.pendingSignals.length === 0) return;
    const task = this.flushPending(active).finally(() => {
      if (this.flushing === task) {
        this.flushing = undefined;
        if (this.pendingSignals.length > 0 && this.active?.compatible) {
          queueMicrotask(() => void this.flush());
        }
      }
    });
    this.flushing = task;
    return task;
  }

  clear(): void {
    this.cancelRetry();
    this.active = undefined;
    this.pendingSignals = [];
    this.lastErrorCode = undefined;
    clearPersistedTestSession(this.input.sourceKey);
  }

  dispose(): void {
    this.cancelRetry();
  }

  private record(input: Omit<TestSessionSignal, "clientSignalId" | "occurredAt">): void {
    const active = this.active;
    if (!active?.compatible || this.expireIfNeeded()) return;
    if (
      (input.type === "experience_impression" || input.type === "experience_action") &&
      !active.testExperienceDecisionReady
    ) {
      return;
    }
    if (!isSignalAllowed(active.testPlan, input)) return;
    if (this.pendingSignals.length >= MAX_PENDING_SIGNALS) {
      this.pendingSignals.shift();
      safeWarn(this.input.debug, "SDK Test & Validate signal queue reached its temporary limit.");
    }
    this.pendingSignals.push({
      clientSignalId: createUuid(),
      occurredAt: new Date().toISOString(),
      ...input,
    });
    this.persist();
    void this.flush();
  }

  private async flushPending(active: ActiveSession): Promise<void> {
    const signals = this.pendingSignals.slice(0, MAX_PENDING_SIGNALS);
    try {
      const response = await this.transport().signals(this.input.sourceKey, {
        schemaVersion: 2,
        participantId: active.participantId,
        sessionToken: active.sessionToken,
        signals,
      });
      const discarded = new Set<string>([...response.accepted, ...response.duplicates]);
      for (const rejected of response.rejected) {
        if (!rejected.retryable) discarded.add(rejected.clientSignalId);
      }
      if (discarded.size > 0) {
        this.pendingSignals = this.pendingSignals.filter(
          (signal) => !discarded.has(signal.clientSignalId),
        );
      }
      const retryable = response.rejected.some((item) => item.retryable);
      if (!retryable) {
        this.lastErrorCode = undefined;
        this.retryAttempt = 0;
      } else {
        this.scheduleRetry();
      }
      this.persist();
    } catch (error) {
      this.lastErrorCode = errorCode(error);
      this.persist();
      this.scheduleRetry();
    }
  }

  private requireActive(): ActiveSession {
    this.expireIfNeeded();
    const active = this.active;
    if (!active || !active.compatible || isExpired(active.expiresAt)) {
      throw new Error("No compatible SDK Test & Validate session is active.");
    }
    return active;
  }

  private metadata() {
    return {
      platform: "web" as const,
      sdkFamily: "web" as const,
      sdkVersion: SDK_VERSION,
      locale: locale(),
    };
  }

  private consent() {
    return this.input.getConsent();
  }

  private capabilities() {
    return {
      deeplink: false,
      identity: true,
      screen: false,
      experiences: this.input.experiencesEnabled(),
      offlineQueue: true,
    };
  }

  private expireIfNeeded(): boolean {
    if (!this.active || !isExpired(this.active.expiresAt)) return false;
    this.clear();
    return true;
  }

  private persist(): void {
    const active = this.active;
    if (!active) {
      clearPersistedTestSession(this.input.sourceKey);
      return;
    }
    savePersistedTestSession(this.input.sourceKey, {
      version: 2,
      active,
      pendingSignals: this.pendingSignals,
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.active?.compatible || this.expireIfNeeded()) return;
    const base = Math.min(RETRY_MAX_DELAY_MS, 1_000 * 2 ** Math.min(this.retryAttempt, 6));
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.flush();
      },
      base + Math.floor(Math.random() * Math.max(1, base * 0.25)),
    );
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private transport(): TestSessionTransport {
    return (
      this.input.transport ??
      new HttpTestSessionTransport(this.input.collectorOrigin, this.input.timeoutMs)
    );
  }
}

function parsePairing(
  pairing: TestSessionPairing,
): { pairingToken: string } | { pairingCode: string } {
  if (typeof pairing !== "string") {
    if (Boolean(pairing.pairingToken) === Boolean(pairing.pairingCode)) {
      throw new TypeError("Provide exactly one pairingToken or pairingCode.");
    }
    return pairing.pairingToken
      ? { pairingToken: validateToken(pairing.pairingToken) }
      : { pairingCode: validateCode(pairing.pairingCode!) };
  }
  const value = pairing.trim();
  if (!value) throw new TypeError("A pairing token or code is required.");
  const fromUrl = tokenFromPairingUrl(value);
  if (fromUrl) return { pairingToken: validateToken(fromUrl) };
  return /^[A-Z2-9]{16}$/i.test(value)
    ? { pairingCode: validateCode(value) }
    : { pairingToken: validateToken(value) };
}

function tokenFromPairingUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const isCanonicalHostPath = url.pathname === "/_wts/test/pair";
    const isLegacyPath =
      (url.hostname === "wts.is" || url.hostname === "www.wts.is") &&
      url.pathname === "/sdk-test/pair";
    if (url.protocol !== "https:" || (!isCanonicalHostPath && !isLegacyPath)) return undefined;
    return url.searchParams.get("pairing")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function validateToken(value: string): string {
  if (value.length < 32 || value.length > 512) {
    throw new TypeError("Pairing tokens must contain 32 to 512 characters.");
  }
  return value;
}

function validateCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z2-9]{16}$/.test(normalized)) {
    throw new TypeError("Pairing codes must contain 16 uppercase base32 characters.");
  }
  return normalized;
}

function validateProbeUrl(value: string): void {
  if (value.length > 2_048) throw new TypeError("Test resolve URLs cannot exceed 2048 characters.");
  try {
    if (new URL(value).protocol !== "https:")
      throw new TypeError("Test resolve URLs must use HTTPS.");
  } catch (error) {
    if (error instanceof TypeError && error.message === "Test resolve URLs must use HTTPS.") {
      throw error;
    }
    throw new TypeError("A valid HTTPS URL is required for a test resolve.");
  }
}

function describePlanProperties(
  properties: TestSessionPlan["events"][number]["properties"],
): Pick<TestSessionSignal, "propertyKeys" | "propertyTypes"> {
  const entries = properties.slice(0, 20);
  return {
    propertyKeys: entries.map((property) => property.key),
    propertyTypes: Object.fromEntries(entries.map((property) => [property.key, property.type])),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof TransportError) return error.code ?? `HTTP_${error.status}`;
  return "TEST_SESSION_TRANSPORT_ERROR";
}

function isExpired(expiresAt: string): boolean {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

function loadPersistedTestSession(sourceKey: string): PersistedTestSession | undefined {
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const value = JSON.parse(
      sessionStorage.getItem(testSessionStorageKey(sourceKey)) ?? "null",
    ) as unknown;
    if (!isPersistedTestSession(value)) return undefined;
    return {
      version: 2,
      active: {
        ...value.active,
        checks: value.active.checks.map((check) => ({ ...check })),
      },
      pendingSignals: value.pendingSignals
        .map(sanitizeStoredSignal)
        .filter((signal): signal is TestSessionSignal => Boolean(signal))
        .slice(0, MAX_PENDING_SIGNALS),
    };
  } catch {
    return undefined;
  }
}

function savePersistedTestSession(sourceKey: string, state: PersistedTestSession): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(testSessionStorageKey(sourceKey), JSON.stringify(state));
  } catch {
    // Test-session retry remains in memory when browser session storage is unavailable.
  }
}

function clearPersistedTestSession(sourceKey: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(testSessionStorageKey(sourceKey));
  } catch {
    // A blocked session storage API is equivalent to an already cleared test session.
  }
}

function isPersistedTestSession(value: unknown): value is PersistedTestSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedTestSession>;
  if (candidate.version !== 2 || !candidate.active || !Array.isArray(candidate.pendingSignals))
    return false;
  const active = candidate.active;
  return (
    typeof active.sessionId === "string" &&
    typeof active.participantId === "string" &&
    typeof active.sessionToken === "string" &&
    typeof active.expiresAt === "string" &&
    typeof active.compatible === "boolean" &&
    typeof active.requiredSdkVersion === "string" &&
    Array.isArray(active.checks) &&
    isTestSessionPlan(active.testPlan)
  );
}

function isTestSessionPlan(value: unknown): value is TestSessionPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<TestSessionPlan>;
  if (
    !Array.isArray(plan.events) ||
    !("profile" in plan) ||
    !("deepLink" in plan) ||
    !("experience" in plan) ||
    !("screen" in plan)
  ) {
    return false;
  }
  return plan.events.every(
    (event) =>
      Boolean(event) &&
      typeof event.eventKey === "string" &&
      Array.isArray(event.properties) &&
      typeof event.revenueEnabled === "boolean" &&
      event.properties.every(
        (property) =>
          Boolean(property) &&
          typeof property.key === "string" &&
          typeof property.type === "string" &&
          typeof property.required === "boolean",
      ),
  );
}

function sanitizeStoredSignal(value: unknown): TestSessionSignal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const signal = value as Partial<TestSessionSignal>;
  if (
    typeof signal.clientSignalId !== "string" ||
    typeof signal.type !== "string" ||
    typeof signal.outcome !== "string" ||
    typeof signal.occurredAt !== "string"
  ) {
    return undefined;
  }
  const allowedTypes = new Set<TestSessionSignal["type"]>([
    "sdk_connected",
    "consent",
    "deep_link_resolved",
    "event_recorded",
    "identity_recorded",
    "screen_recorded",
    "experience_impression",
    "experience_action",
    "probe_completed",
    "sdk_left",
  ]);
  const allowedOutcomes = new Set<TestSessionSignal["outcome"]>([
    "passed",
    "failed",
    "observed",
    "blocked",
  ]);
  if (!allowedTypes.has(signal.type) || !allowedOutcomes.has(signal.outcome)) {
    return undefined;
  }
  return {
    clientSignalId: signal.clientSignalId,
    type: signal.type,
    outcome: signal.outcome,
    occurredAt: signal.occurredAt,
    ...(typeof signal.method === "string" ? { method: signal.method } : {}),
    ...(typeof signal.eventKey === "string" ? { eventKey: signal.eventKey } : {}),
    ...(typeof signal.screenName === "string" ? { screenName: signal.screenName } : {}),
    ...(Array.isArray(signal.propertyKeys)
      ? {
          propertyKeys: signal.propertyKeys
            .filter((key): key is string => typeof key === "string")
            .slice(0, 20),
        }
      : {}),
    ...(signal.propertyTypes && typeof signal.propertyTypes === "object"
      ? {
          propertyTypes: Object.fromEntries(
            Object.entries(signal.propertyTypes).filter(
              ([, type]) =>
                type === "string" ||
                type === "number" ||
                type === "boolean" ||
                type === "date" ||
                type === "string_array",
            ),
          ),
        }
      : {}),
    ...(signal.revenue &&
    typeof signal.revenue === "object" &&
    signal.revenue.present === true &&
    typeof signal.revenue.currency === "string" &&
    /^[A-Z]{3}$/.test(signal.revenue.currency)
      ? { revenue: { present: true as const, currency: signal.revenue.currency } }
      : {}),
    ...(typeof signal.resultCode === "string" ? { resultCode: signal.resultCode } : {}),
    ...(typeof signal.feature === "string" ? { feature: signal.feature } : {}),
  };
}

function isSignalAllowed(
  plan: TestSessionPlan,
  signal: Omit<TestSessionSignal, "clientSignalId" | "occurredAt">,
): boolean {
  switch (signal.type) {
    case "identity_recorded":
      return Boolean(
        plan.profile?.selected &&
        plan.profile.available &&
        signal.method &&
        plan.profile.allowedMethods.includes(signal.method as TestSessionIdentityMethod),
      );
    case "event_recorded":
      return Boolean(
        signal.eventKey &&
        plan.events.some(
          (event) =>
            event.eventKey === signal.eventKey && (!signal.revenue || event.revenueEnabled),
        ),
      );
    case "screen_recorded":
      return plan.screen?.selected === true;
    case "deep_link_resolved":
    case "probe_completed":
      return Boolean(plan.deepLink?.selected && plan.deepLink.available);
    case "experience_impression":
    case "experience_action":
      return Boolean(plan.experience?.selected && plan.experience.available);
    default:
      return true;
  }
}

function incrementProbeDescriptor(): Pick<TestSessionSignal, "propertyKeys" | "propertyTypes"> {
  return {
    propertyKeys: ["sdk_test_increment"],
    propertyTypes: { sdk_test_increment: "number" },
  };
}
