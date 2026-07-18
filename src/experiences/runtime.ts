import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, SDK_VERSION } from "../constants";
import { byteLength, createUuid, locale, safeWarn } from "../runtime";
import { TransportError } from "../transport";
import type {
  AvailableExperience,
  ConsentState,
  ExperienceAction,
  ExperienceActionHandler,
  ExperienceAvailableHandler,
  ExperienceConsentResult,
  ExperienceConsentState,
  ExperienceContext,
  ExperienceDiagnostics,
  ExperienceOptions,
  Identity,
  StorageAdapter,
} from "../types";
import type { RenderHandle } from "./renderer";
import { ExperienceTransport } from "./transport";
import type {
  BootstrapResponse,
  ExperienceDecision,
  ExperienceInteraction,
  ExperienceManifest,
  ManifestCampaign,
  QueuedExperience,
  RuntimeContext,
  TargetNode,
} from "./types";

type ResolvedExperienceOptions = Required<ExperienceOptions>;

interface ExperienceRuntimeDependencies {
  sourceKey: string;
  collectorOrigin: string;
  timeoutMs: number;
  debug: boolean;
  options: ResolvedExperienceOptions;
  getAnalyticsConsent(): ConsentState;
  getIdentity(): Identity | undefined;
  getStorage(): StorageAdapter | undefined;
  flushIdentity(): Promise<unknown>;
  onInteraction?(type: ExperienceInteraction["type"]): void;
}

const MANIFEST_CACHE_MS = 5 * 60_000;
const MAX_CANDIDATES = 5;
const MAX_SESSION_OVERLAYS = 2;
const MAX_SESSION_IMPRESSIONS = 5;

export class ExperienceRuntime {
  private consent: ExperienceConsentState = "pending";
  private readonly transport: ExperienceTransport;
  private manifest: ExperienceManifest | undefined;
  private manifestLoadedAt = 0;
  private queue: QueuedExperience[] = [];
  private current: QueuedExperience | undefined;
  private renderHandle: RenderHandle | undefined;
  private actionHandlers = new Set<ExperienceActionHandler>();
  private availableHandlers = new Set<ExperienceAvailableHandler>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private cooldownUntil = 0;
  private sessionImpressions = 0;
  private sessionOverlays = 0;
  private readonly testDeviceToken = createUuid();
  private lastErrorCode: string | null = null;
  private destroyed = false;
  private suppressInteractionCallbacks = false;

  constructor(private readonly dependencies: ExperienceRuntimeDependencies) {
    this.transport = new ExperienceTransport(
      dependencies.collectorOrigin,
      dependencies.timeoutMs,
      dependencies.sourceKey,
    );
  }

  async setConsent(consent: ExperienceConsentState): Promise<ExperienceConsentResult> {
    if (this.destroyed) return { accepted: false, reason: "destroyed" };
    if (!this.dependencies.options.enabled) {
      return { accepted: false, reason: "feature_disabled" };
    }
    if (consent === "denied" || consent === "pending") {
      this.consent = consent;
      await this.clearRuntimeState(true);
      return { accepted: true };
    }
    if (this.dependencies.getAnalyticsConsent() !== "granted") {
      return { accepted: false, reason: "analytics_consent_required" };
    }
    if (consent === "personalized" && !this.dependencies.getIdentity()) {
      return { accepted: false, reason: "profile_consent_required" };
    }
    this.consent = consent;
    try {
      await this.ensureManifest(true);
      await this.flushInteractions();
      return { accepted: true };
    } catch (error) {
      this.handleError(error);
      return { accepted: true };
    }
  }

  onAction(handler: ExperienceActionHandler): () => void {
    this.actionHandlers.add(handler);
    return () => this.actionHandlers.delete(handler);
  }

  onAvailable(handler: ExperienceAvailableHandler): () => void {
    this.availableHandlers.add(handler);
    return () => this.availableHandlers.delete(handler);
  }

  async evaluate(context: ExperienceContext): Promise<void> {
    if (!this.canEvaluate()) return;
    const manifest = await this.ensureManifest();
    if (!manifest) return;
    const runtimeContext: RuntimeContext = {
      ...(context.pathname ? { pathname: context.pathname } : {}),
      ...(context.pageName ? { pageName: context.pageName } : {}),
      ...(context.eventKey ? { eventKey: context.eventKey } : {}),
      properties: context.properties,
      ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
    };
    if (this.consent === "personalized") {
      await this.dependencies.flushIdentity();
      const response = await this.transport.decide({
        consent: this.consent,
        profileConsentGranted: true,
        identity: this.requireIdentity(),
        metadata: this.metadata,
        settings: this.settings,
        testDeviceToken: this.testDeviceToken,
        candidateVersionIds: manifest.campaigns.map((item) => item.campaignVersionId),
        context: { ...runtimeContext, trigger: context.trigger },
      });
      await this.acceptDecisions(response.decisions, runtimeContext);
      return;
    }
    const candidates = manifest.campaigns
      .filter((campaign) => !campaign.requiresPersonalization)
      .filter((campaign) => triggerMatches(campaign, runtimeContext))
      .filter((campaign) => targetingMatches(campaign.targeting, manifest, this.metadata.locale))
      .sort(compareCampaigns);
    for (const campaign of candidates) await this.acceptManifestCampaign(campaign, runtimeContext);
  }

  async presentNext(): Promise<boolean> {
    if (this.current || Date.now() < this.cooldownUntil || this.queue.length === 0) return false;
    if (this.sessionImpressions >= MAX_SESSION_IMPRESSIONS) {
      this.queue = [];
      return false;
    }
    const candidate = this.queue.shift()!;
    if (
      ["modal", "slide_in"].includes(candidate.placement) &&
      this.sessionOverlays >= MAX_SESSION_OVERLAYS
    ) {
      return this.presentNext();
    }
    this.current = candidate;
    await this.record(candidate, "render_started");
    try {
      const renderer = await import("./renderer");
      this.renderHandle = await renderer.renderExperience(candidate, {
        locale: this.metadata.locale,
        onAction: (action) => void this.handleAction(candidate, action),
        onDismiss: (reason) => void this.finish(candidate, reason),
        onImpression: () => void this.recordImpression(candidate),
      });
      await this.record(candidate, "render_succeeded");
      return true;
    } catch (error) {
      await this.record(candidate, "render_failed", {
        failureCode: normalizeErrorCode(error),
      });
      this.current = undefined;
      this.renderHandle = undefined;
      this.cooldownUntil = Date.now() + 3_000;
      this.handleError(error);
      return false;
    }
  }

  async dismissCurrent(): Promise<boolean> {
    if (!this.current || !this.renderHandle) return false;
    this.renderHandle.dismiss("dismissed");
    return true;
  }

  diagnostics(): ExperienceDiagnostics {
    return {
      enabled: this.dependencies.options.enabled,
      consent: this.consent,
      renderMode: this.dependencies.options.renderMode,
      manifestVersion: this.manifest?.sourceManifestVersion ?? null,
      manifestExpiresAt: this.manifest?.expiresAt ?? null,
      queued: this.queue.length,
      presenting: Boolean(this.current),
      sessionImpressions: this.sessionImpressions,
      testDeviceToken: this.testDeviceToken,
      lastErrorCode: this.lastErrorCode,
    };
  }

  async flushInteractions(): Promise<void> {
    if (!this.canEvaluate()) return;
    const storage = this.dependencies.getStorage();
    if (!storage) return;
    const state = await storage.load();
    const interactions = takeInteractionBatch(state.experienceQueue);
    if (interactions.length === 0) return;
    try {
      const result = await this.transport.sendInteractions({
        consent: this.activeConsent,
        profileConsentGranted: this.consent === "personalized",
        identity: this.requireIdentity(),
        interactions,
      });
      const remove = new Set([...result.accepted, ...result.duplicates]);
      for (const rejection of result.rejected) {
        if (!rejection.retryable) remove.add(rejection.clientInteractionId);
      }
      await storage.removeExperiences(remove);
      if (result.rejected.some((item) => item.retryable)) this.scheduleRetry();
      else {
        this.retryAttempt = 0;
        const pending = await storage.load();
        if (pending.experienceQueue.length > 0) queueMicrotask(() => void this.flushInteractions());
      }
    } catch (error) {
      if (error instanceof TransportError && !error.retryable) {
        await storage.removeExperiences(
          new Set(interactions.map((item) => item.clientInteractionId)),
        );
      } else {
        this.scheduleRetry();
      }
      this.handleError(error);
    }
  }

  async reset(): Promise<void> {
    await this.clearRuntimeState(true);
    this.consent = "pending";
    this.sessionImpressions = 0;
    this.sessionOverlays = 0;
  }

  async identityChanged(): Promise<void> {
    await this.clearRuntimeState(false);
    if (this.canEvaluate()) {
      try {
        await this.ensureManifest(true);
      } catch (error) {
        this.handleError(error);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.renderHandle?.dismiss("dismissed", false);
    this.renderHandle = undefined;
    this.current = undefined;
    this.queue = [];
    this.actionHandlers.clear();
    this.availableHandlers.clear();
  }

  private async ensureManifest(force = false): Promise<ExperienceManifest | undefined> {
    if (!this.canEvaluate()) return undefined;
    if (
      !force &&
      this.manifest &&
      Date.now() - this.manifestLoadedAt < MANIFEST_CACHE_MS &&
      Date.parse(this.manifest.expiresAt) > Date.now()
    ) {
      return this.manifest;
    }
    const response: BootstrapResponse = await this.transport.bootstrap({
      consent: this.activeConsent,
      profileConsentGranted: this.consent === "personalized",
      identity: this.requireIdentity(),
      metadata: this.metadata,
      settings: this.settings,
      testDeviceToken: this.testDeviceToken,
    });
    if (
      response.manifest.schemaVersion !== 1 ||
      response.expiresAt !== response.manifest.expiresAt ||
      Date.parse(response.expiresAt) <= Date.now() ||
      !response.keyId ||
      !response.signature
    ) {
      throw new Error("EXPERIENCE_MANIFEST_INVALID");
    }
    this.manifest = response.manifest;
    this.manifestLoadedAt = Date.now();
    this.lastErrorCode = null;
    return this.manifest;
  }

  private async acceptManifestCampaign(
    campaign: ManifestCampaign,
    context: RuntimeContext,
  ): Promise<void> {
    const assignment = campaign.assignment;
    if (!assignment || !campaign.grant) return;
    if (assignment.kind === "holdout") {
      await this.recordBranch(
        campaign,
        assignment.assignmentId,
        null,
        campaign.grant,
        "assigned_holdout",
        context,
      );
      return;
    }
    const variant = campaign.variants.find((item) => item.id === assignment.variantId);
    if (!variant) return;
    await this.enqueueCandidate(
      {
        campaignId: campaign.campaignId,
        campaignVersionId: campaign.campaignVersionId,
        assignmentId: assignment.assignmentId,
        variantId: assignment.variantId,
        exposureId: createUuid(),
        placement: campaign.placement,
        priority: campaign.priority,
        content: variant.content,
        ...(variant.asset?.url ? { assetUrl: variant.asset.url } : {}),
        grant: campaign.grant,
        defaultLocale: campaign.defaultLocale,
        eligibleAt: Date.now(),
        ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
      },
      context,
    );
  }

  private async acceptDecisions(
    decisions: ExperienceDecision[],
    context: RuntimeContext,
  ): Promise<void> {
    for (const decision of decisions) {
      if (decision.holdout) {
        await this.recordBranch(
          {
            campaignId: decision.campaignId,
            campaignVersionId: decision.campaignVersionId,
          },
          decision.assignmentId,
          null,
          decision.grant,
          "assigned_holdout",
          context,
        );
        continue;
      }
      if (!decision.content) continue;
      await this.enqueueCandidate(
        {
          campaignId: decision.campaignId,
          campaignVersionId: decision.campaignVersionId,
          assignmentId: decision.assignmentId,
          variantId: decision.variantId,
          exposureId: createUuid(),
          placement: decision.placement,
          priority: decision.priority,
          content: decision.content.content,
          ...(decision.content.asset?.url ? { assetUrl: decision.content.asset.url } : {}),
          grant: decision.grant,
          defaultLocale: "en",
          eligibleAt: Date.now(),
          ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
        },
        context,
      );
    }
  }

  private async enqueueCandidate(candidate: QueuedExperience, context: RuntimeContext) {
    if (
      this.queue.some(
        (item) =>
          item.campaignId === candidate.campaignId &&
          item.campaignVersionId === candidate.campaignVersionId,
      ) ||
      (this.current?.campaignId === candidate.campaignId &&
        this.current.campaignVersionId === candidate.campaignVersionId)
    ) {
      return;
    }
    await this.record(candidate, "assigned_variant");
    await this.record(candidate, "eligible");
    this.queue.push(candidate);
    this.queue.sort(compareQueued);
    if (this.queue.length > MAX_CANDIDATES) this.queue.length = MAX_CANDIDATES;
    await this.record(candidate, "queued");
    const publicCandidate: AvailableExperience = candidate;
    for (const handler of this.availableHandlers) {
      try {
        handler(publicCandidate);
      } catch (error) {
        this.handleError(error);
      }
    }
    if (this.dependencies.options.renderMode === "automatic") void this.presentNext();
    void context;
  }

  private async recordBranch(
    campaign: Pick<ManifestCampaign, "campaignId" | "campaignVersionId">,
    assignmentId: string,
    variantId: string | null,
    grant: string,
    type: "assigned_holdout",
    context: RuntimeContext,
  ) {
    const interaction = this.createInteraction(
      {
        campaignId: campaign.campaignId,
        campaignVersionId: campaign.campaignVersionId,
        assignmentId,
        variantId,
        exposureId: null,
        grant,
        ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
      },
      type,
    );
    await this.enqueueInteraction(interaction);
  }

  private async record(
    experience: QueuedExperience,
    type: ExperienceInteraction["type"],
    details: { actionId?: string; failureCode?: string } = {},
  ) {
    await this.enqueueInteraction(
      this.createInteraction(experience, type, details.actionId, details.failureCode),
    );
  }

  private async recordImpression(experience: QueuedExperience) {
    if (this.current?.exposureId !== experience.exposureId) return;
    this.sessionImpressions += 1;
    if (["modal", "slide_in"].includes(experience.placement)) this.sessionOverlays += 1;
    await this.record(experience, "impression");
  }

  private async finish(experience: QueuedExperience, reason: "dismissed" | "auto_closed") {
    if (this.suppressInteractionCallbacks) return;
    if (this.current?.exposureId !== experience.exposureId) return;
    await this.record(experience, reason);
    this.current = undefined;
    this.renderHandle = undefined;
    this.cooldownUntil = Date.now() + 3_000;
    setTimeout(() => {
      if (this.dependencies.options.renderMode === "automatic") void this.presentNext();
    }, 3_000);
  }

  private async handleAction(experience: QueuedExperience, action: ExperienceAction) {
    if (!this.isActionAllowed(action)) {
      this.lastErrorCode = "EXPERIENCE_ACTION_NOT_ALLOWED";
      return;
    }
    let handled = false;
    for (const handler of this.actionHandlers) {
      try {
        handled = (await handler({ experience, action, handled })) === true || handled;
      } catch (error) {
        this.handleError(error);
      }
    }
    if (!handled) handled = await this.performSafeDefaultAction(action);
    const content = selectLocalizedContent(experience.content.translations, this.metadata.locale);
    await this.record(
      experience,
      content?.primaryAction?.id === action.id ? "primary_action" : "secondary_action",
      { actionId: action.id },
    );
    if (handled || action.type === "DISMISS") {
      this.renderHandle?.dismiss("dismissed");
      if (["OPEN_INTERNAL_ROUTE", "OPEN_DEEP_LINK", "OPEN_WEB_URL"].includes(action.type)) {
        this.queue = [];
      }
    }
  }

  private async performSafeDefaultAction(action: ExperienceAction): Promise<boolean> {
    const target = action.target;
    switch (action.type) {
      case "DISMISS":
        return true;
      case "COPY_CODE":
        if (!target || !navigator.clipboard) return false;
        await navigator.clipboard.writeText(target);
        return true;
      case "OPEN_INTERNAL_ROUTE":
        if (!target || !this.dependencies.options.allowedInternalRoutes.includes(target))
          return false;
        history.pushState(history.state, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
        return true;
      case "CUSTOM_CALLBACK":
        return Boolean(target && this.dependencies.options.allowedCallbackKeys.includes(target));
      case "OPEN_WEB_URL":
        if (!target) return false;
        return this.openWebUrl(target);
      case "OPEN_DEEP_LINK":
        if (!target) return false;
        return this.openDeepLink(target);
    }
  }

  private isActionAllowed(action: ExperienceAction): boolean {
    const target = action.target;
    switch (action.type) {
      case "DISMISS":
        return true;
      case "COPY_CODE":
        return Boolean(target);
      case "OPEN_INTERNAL_ROUTE":
        return Boolean(target && this.dependencies.options.allowedInternalRoutes.includes(target));
      case "CUSTOM_CALLBACK":
        return Boolean(target && this.dependencies.options.allowedCallbackKeys.includes(target));
      case "OPEN_WEB_URL":
        if (!target) return false;
        try {
          const parsed = new URL(target);
          return (
            parsed.protocol === "https:" &&
            this.dependencies.options.allowedWebOrigins.includes(parsed.origin.toLowerCase())
          );
        } catch {
          return false;
        }
      case "OPEN_DEEP_LINK":
        if (!target) return false;
        try {
          const parsed = new URL(target);
          const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
          return (
            this.dependencies.options.allowedDeepLinkSchemes.includes(scheme) ||
            (parsed.protocol === "https:" &&
              this.dependencies.options.allowedDeepLinkHosts.includes(
                parsed.hostname.toLowerCase(),
              ))
          );
        } catch {
          return false;
        }
    }
  }

  private openWebUrl(target: string) {
    try {
      const parsed = new URL(target);
      if (
        parsed.protocol !== "https:" ||
        !this.dependencies.options.allowedWebOrigins.includes(parsed.origin.toLowerCase())
      ) {
        return false;
      }
      window.location.assign(parsed.href);
      return true;
    } catch {
      return false;
    }
  }

  private openDeepLink(target: string) {
    try {
      const parsed = new URL(target);
      const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
      const allowed =
        this.dependencies.options.allowedDeepLinkSchemes.includes(scheme) ||
        (parsed.protocol === "https:" &&
          this.dependencies.options.allowedDeepLinkHosts.includes(parsed.hostname.toLowerCase()));
      if (!allowed) return false;
      window.location.assign(parsed.href);
      return true;
    } catch {
      return false;
    }
  }

  private createInteraction(
    experience: {
      grant: string;
      campaignId: string;
      campaignVersionId: string;
      assignmentId: string | null;
      variantId: string | null;
      exposureId: string | null;
      triggerEventId?: string;
    },
    type: ExperienceInteraction["type"],
    actionId?: string,
    failureCode?: string,
  ): ExperienceInteraction {
    return {
      clientInteractionId: createUuid(),
      grant: experience.grant,
      campaignId: experience.campaignId,
      campaignVersionId: experience.campaignVersionId,
      assignmentId: experience.assignmentId,
      variantId: experience.variantId,
      exposureId: experience.exposureId,
      type,
      actionId: actionId ?? null,
      triggerEventId: experience.triggerEventId ?? null,
      occurredAt: new Date().toISOString(),
      metadata: this.metadata,
      failureCode: failureCode ?? null,
    };
  }

  private async enqueueInteraction(interaction: ExperienceInteraction) {
    const storage = this.dependencies.getStorage();
    if (!storage) return;
    await storage.enqueueExperience(interaction);
    this.dependencies.onInteraction?.(interaction.type);
    queueMicrotask(() => void this.flushInteractions());
  }

  private async clearRuntimeState(clearStored: boolean) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.suppressInteractionCallbacks = true;
    this.renderHandle?.dismiss("dismissed", false);
    this.renderHandle = undefined;
    this.current = undefined;
    this.queue = [];
    this.manifest = undefined;
    this.manifestLoadedAt = 0;
    try {
      if (clearStored) {
        const storage = this.dependencies.getStorage();
        const state = await storage?.load();
        if (state) {
          await storage?.removeExperiences(
            new Set(state.experienceQueue.map((item) => item.clientInteractionId)),
          );
        }
      }
    } finally {
      this.suppressInteractionCallbacks = false;
    }
  }

  private scheduleRetry() {
    if (this.retryTimer || !this.canEvaluate()) return;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(this.retryAttempt, 6));
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.flushInteractions();
      },
      base + Math.floor(Math.random() * base * 0.25),
    );
  }

  private handleError(error: unknown) {
    this.lastErrorCode = normalizeErrorCode(error);
    safeWarn(this.dependencies.debug, `Experiences request failed (${this.lastErrorCode}).`);
  }

  private canEvaluate(): boolean {
    return (
      !this.destroyed &&
      this.dependencies.options.enabled &&
      this.dependencies.getAnalyticsConsent() === "granted" &&
      (this.consent === "contextual" || this.consent === "personalized") &&
      Boolean(this.dependencies.getIdentity()) &&
      Boolean(this.dependencies.getStorage())
    );
  }

  private requireIdentity(): Identity {
    const identity = this.dependencies.getIdentity();
    if (!identity) throw new Error("EXPERIENCE_IDENTITY_UNAVAILABLE");
    return identity;
  }

  private get activeConsent(): "contextual" | "personalized" {
    if (this.consent !== "contextual" && this.consent !== "personalized") {
      throw new Error("EXPERIENCE_CONSENT_REQUIRED");
    }
    return this.consent;
  }

  private get metadata() {
    return { platform: "web" as const, sdkVersion: SDK_VERSION, locale: locale() };
  }

  private get settings() {
    const options = this.dependencies.options;
    return {
      allowedInternalRoutes: options.allowedInternalRoutes,
      allowedCallbackKeys: options.allowedCallbackKeys,
      allowedDeepLinkHosts: options.allowedDeepLinkHosts,
      allowedDeepLinkSchemes: options.allowedDeepLinkSchemes,
      allowedWebOrigins: options.allowedWebOrigins,
    };
  }
}

function selectLocalizedContent(
  translations: AvailableExperience["content"]["translations"],
  requestedLocale: string,
) {
  return (
    translations[requestedLocale] ??
    translations[requestedLocale.split("-")[0] ?? ""] ??
    Object.values(translations)[0]
  );
}

function triggerMatches(campaign: ManifestCampaign, context: RuntimeContext): boolean {
  const trigger = campaign.trigger;
  if (trigger.type === "page_view") {
    if (trigger.match.kind === "pathname_exact") return context.pathname === trigger.match.value;
    if (trigger.match.kind === "pathname_prefix") {
      return Boolean(context.pathname?.startsWith(trigger.match.value));
    }
    return context.pageName === trigger.match.value;
  }
  if (trigger.type !== "custom_event" || context.eventKey !== trigger.eventKey) return false;
  return trigger.conditions.every((condition) =>
    compare(context.properties[condition.key], condition.operator, condition.value),
  );
}

function targetingMatches(
  node: TargetNode,
  manifest: ExperienceManifest,
  currentLocale: string,
): boolean {
  if (node.kind === "all") {
    return node.conditions.every((child) => targetingMatches(child, manifest, currentLocale));
  }
  if (node.kind === "any") {
    return node.conditions.some((child) => targetingMatches(child, manifest, currentLocale));
  }
  if (node.kind === "not") return !targetingMatches(node.condition, manifest, currentLocale);
  const current =
    node.field === "platform"
      ? "web"
      : node.field === "locale"
        ? currentLocale
        : node.field === "source_id"
          ? manifest.sourceId
          : node.field === "environment"
            ? manifest.environment
            : node.field === "actor_type"
              ? "anonymous"
              : undefined;
  return compare(current, node.operator, node.value);
}

function compare(current: unknown, operator: string, expected: unknown): boolean {
  if (operator === "exists") return current !== undefined && current !== null;
  if (operator === "equals") return current === expected;
  if (operator === "not_equals") return current !== expected;
  if (operator === "in") return Array.isArray(expected) && expected.includes(current);
  if (operator === "not_in") return Array.isArray(expected) && !expected.includes(current);
  if (typeof current !== "number" || typeof expected !== "number") return false;
  if (operator === "gt") return current > expected;
  if (operator === "gte") return current >= expected;
  if (operator === "lt") return current < expected;
  return operator === "lte" && current <= expected;
}

function compareCampaigns(left: ManifestCampaign, right: ManifestCampaign) {
  return right.priority - left.priority || left.campaignId.localeCompare(right.campaignId);
}

function compareQueued(left: QueuedExperience, right: QueuedExperience) {
  return (
    right.priority - left.priority ||
    left.eligibleAt - right.eligibleAt ||
    left.campaignId.localeCompare(right.campaignId)
  );
}

function takeInteractionBatch(queue: ExperienceInteraction[]) {
  const batch: ExperienceInteraction[] = [];
  for (const interaction of queue.slice(0, MAX_BATCH_EVENTS)) {
    if (byteLength({ schemaVersion: 1, interactions: [...batch, interaction] }) > MAX_BATCH_BYTES) {
      break;
    }
    batch.push(interaction);
  }
  return batch;
}

function normalizeErrorCode(error: unknown): string {
  if (error instanceof TransportError) return error.code ?? `HTTP_${error.status}`;
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return "EXPERIENCE_RUNTIME_ERROR";
}
