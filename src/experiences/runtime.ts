import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, SDK_VERSION } from "../constants";
import { byteLength, createUuid, locale, safeWarn } from "../runtime";
import { TransportError } from "../transport";
import { isUnsafeDeepLinkScheme } from "../validation";
import { verifyExperienceManifestPayload } from "./manifest-verifier";
import type {
  ConsentState,
  ExperienceAction,
  ExperienceActionHandler,
  ExperienceAvailableHandler,
  ExperienceConsentResult,
  ExperienceConsentState,
  ExperienceDismissal,
  ExperienceContext,
  ExperienceDiagnostics,
  ExperienceOptions,
  ExperiencePresentationResult,
  Identity,
  StorageAdapter,
  WtsExperience,
  WtsExperienceManualPresentation,
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

export interface ExperienceRuntimeDependencies {
  sourceKey: string;
  collectorOrigin: string;
  timeoutMs: number;
  debug: boolean;
  options: ResolvedExperienceOptions;
  getAnalyticsConsent(): ConsentState;
  getProfileConsent(): boolean;
  /** True only after an identify mutation was accepted by the collector. */
  getProfileIdentityReady(): boolean;
  getIdentity(): Identity | undefined;
  getStorage(): StorageAdapter | undefined;
  flushIdentity(): Promise<unknown>;
  /** A facade-owned, per-client opaque token for unpublished device tests. */
  testDeviceToken?: string;
  onInteraction?(type: ExperienceInteraction["type"]): void;
}

const MANIFEST_CACHE_MS = 5 * 60_000;
const MAX_CANDIDATES = 5;
const MAX_SESSION_OVERLAYS = 2;
const MAX_SESSION_IMPRESSIONS = 5;
const MAX_MANUAL_PRESENTATION_HISTORY = 50;

interface ManualPresentationState {
  rendered: boolean;
  impressionRecorded: boolean;
  dismissed: boolean;
  actions: Set<string>;
}

export class ExperienceRuntime {
  private consent: ExperienceConsentState = "pending";
  private readonly transport: ExperienceTransport;
  private manifest: ExperienceManifest | undefined;
  private manifestLoadedAt = 0;
  private queue: QueuedExperience[] = [];
  private current: QueuedExperience | undefined;
  private renderHandle: RenderHandle | undefined;
  private renderAbortController: AbortController | undefined;
  private readonly reportedImpressionHandles = new Set<string>();
  private readonly reportedActionHandles = new Set<string>();
  private readonly manualPresentations = new Map<string, ManualPresentationState>();
  private manualOfferedHandle: string | undefined;
  private actionHandlers = new Set<ExperienceActionHandler>();
  private availableHandlers = new Set<ExperienceAvailableHandler>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private nextPresentationTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private cooldownUntil = 0;
  private sessionImpressions = 0;
  private sessionOverlays = 0;
  private readonly testDeviceToken: string;
  private lastErrorCode: string | null = null;
  private destroyed = false;
  private suppressInteractionCallbacks = false;

  constructor(private readonly dependencies: ExperienceRuntimeDependencies) {
    this.testDeviceToken = dependencies.testDeviceToken ?? createUuid();
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
    if (consent === "personalized" && this.dependencies.getProfileConsent()) {
      await this.dependencies.flushIdentity();
    }
    if (
      consent === "personalized" &&
      (!this.dependencies.getProfileConsent() || !this.dependencies.getProfileIdentityReady())
    ) {
      this.lastErrorCode = this.dependencies.getProfileConsent()
        ? "EXPERIENCE_PROFILE_IDENTITY_REQUIRED"
        : "EXPERIENCE_PROFILE_CONSENT_REQUIRED";
      return {
        accepted: false,
        reason: this.dependencies.getProfileConsent()
          ? "profile_identity_required"
          : "profile_consent_required",
      };
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

  async profileConsentChanged(): Promise<void> {
    if (this.dependencies.getProfileConsent() || this.consent !== "personalized") return;
    this.consent = "pending";
    await this.clearRuntimeState(true);
  }

  onAction(handler: ExperienceActionHandler): () => void {
    this.actionHandlers.add(handler);
    return () => this.actionHandlers.delete(handler);
  }

  onAvailable(handler: ExperienceAvailableHandler): () => void {
    this.availableHandlers.add(handler);
    this.offerNextManualCandidate();
    return () => this.availableHandlers.delete(handler);
  }

  async evaluate(context: ExperienceContext): Promise<void> {
    if (!this.canEvaluate()) return;
    let manifest: ExperienceManifest | undefined;
    try {
      manifest = await this.ensureManifest();
    } catch (error) {
      this.handleError(error);
      return;
    }
    if (!manifest) return;
    const runtimeContext: RuntimeContext = {
      ...(context.pathname ? { pathname: context.pathname } : {}),
      ...(context.pageName ? { pageName: context.pageName } : {}),
      ...(context.eventKey ? { eventKey: context.eventKey } : {}),
      properties: context.properties,
      ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
    };
    if (this.consent === "personalized") {
      try {
        await this.dependencies.flushIdentity();
        if (
          !this.canEvaluate() ||
          !this.dependencies.getProfileConsent() ||
          !this.dependencies.getProfileIdentityReady()
        ) {
          return;
        }
        const response = await this.transport.decide({
          consent: this.consent,
          profileConsentGranted: this.dependencies.getProfileConsent(),
          identity: this.requireIdentity(),
          metadata: this.metadata,
          settings: this.settings,
          testDeviceToken: this.testDeviceToken,
          candidateVersionIds: manifest.campaigns.map((item) => item.campaignVersionId),
          context: { ...runtimeContext, trigger: context.trigger },
        });
        await this.acceptDecisions(
          response.decisions,
          runtimeContext,
          Date.parse(manifest.expiresAt),
        );
      } catch (error) {
        this.handleError(error);
      }
      return;
    }
    const candidates = manifest.campaigns
      .filter((campaign) => !campaign.requiresPersonalization)
      .filter((campaign) => triggerMatches(campaign, runtimeContext))
      .filter((campaign) => targetingMatches(campaign.targeting, manifest, this.metadata.locale))
      .sort(compareCampaigns);
    const manifestExpiresAt = Date.parse(manifest.expiresAt);
    for (const campaign of candidates) {
      await this.acceptManifestCampaign(campaign, runtimeContext, manifestExpiresAt);
    }
  }

  async presentNext(): Promise<boolean> {
    if (this.dependencies.options.renderMode !== "automatic") return false;
    this.discardExpiredCandidates();
    if (
      !this.canEvaluate() ||
      this.current ||
      Date.now() < this.cooldownUntil ||
      this.queue.length === 0
    ) {
      return false;
    }
    if (this.sessionImpressions >= MAX_SESSION_IMPRESSIONS) {
      this.queue = [];
      return false;
    }
    const candidate = this.queue.shift()!;
    if (isOverlayPlacement(candidate.placement) && this.sessionOverlays >= MAX_SESSION_OVERLAYS) {
      return this.presentNext();
    }
    this.admitOverlay(candidate);
    this.current = candidate;
    await this.record(candidate, "render_started");
    const controller = new AbortController();
    this.renderAbortController = controller;
    try {
      const renderer = await import("./renderer");
      const renderHandle = await renderer.renderExperience(candidate, {
        locale: this.metadata.locale,
        signal: controller.signal,
        onAction: (action) => void this.handleAction(candidate, action),
        onDismiss: (reason) => void this.finish(candidate, reason),
        onImpression: () => void this.recordImpression(candidate),
      });
      if (
        controller.signal.aborted ||
        !this.canEvaluate() ||
        this.current?.exposureId !== candidate.exposureId
      ) {
        renderHandle.dismiss("dismissed", false);
        return false;
      }
      this.renderHandle = renderHandle;
      await this.record(candidate, "render_succeeded");
      return true;
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        if (this.current?.exposureId === candidate.exposureId) this.clearCurrentPresentation();
        return false;
      }
      await this.record(candidate, "render_failed", {
        failureCode: normalizeErrorCode(error),
      });
      this.clearCurrentPresentation();
      this.cooldownUntil = Date.now() + 3_000;
      this.scheduleNextPresentation();
      this.handleError(error);
      return false;
    } finally {
      if (this.renderAbortController === controller) this.renderAbortController = undefined;
    }
  }

  async dismissCurrent(): Promise<boolean> {
    if (!this.current || !this.renderHandle) return false;
    this.renderHandle.dismiss("dismissed");
    return true;
  }

  async acknowledgeExperienceRender(handle: string): Promise<ExperiencePresentationResult> {
    const unavailable = this.manualPresentationUnavailable();
    if (unavailable) return unavailable;
    if (this.discardExpiredCandidates().has(handle)) {
      return this.presentationRejected("manifest_expired");
    }
    const state = this.manualPresentations.get(handle);
    if (!state) return this.presentationRejected("presentation_not_found");
    if (state.rendered) return this.presentationAccepted(true);
    if (state.dismissed) return this.presentationRejected("presentation_not_presenting");
    if (this.manualOfferedHandle !== handle || this.queue[0]?.presentationHandle !== handle) {
      return this.presentationRejected("presentation_not_presenting");
    }
    if (this.current) return this.presentationRejected("presentation_not_presenting");
    const candidate = this.queue.shift()!;
    if (!this.canAdmitOverlay(candidate)) {
      this.manualOfferedHandle = undefined;
      state.dismissed = true;
      this.scheduleNextPresentation();
      return this.presentationRejected("session_overlay_limit_reached");
    }
    this.admitOverlay(candidate);
    this.manualOfferedHandle = undefined;
    this.current = candidate;
    state.rendered = true;
    await this.record(candidate, "render_started");
    await this.record(candidate, "render_succeeded");
    return this.presentationAccepted(false);
  }

  async acknowledgeExperienceImpression(handle: string): Promise<ExperiencePresentationResult> {
    const unavailable = this.manualPresentationUnavailable();
    if (unavailable) return unavailable;
    const state = this.manualPresentations.get(handle);
    if (!state) return this.presentationRejected("presentation_not_found");
    if (state.impressionRecorded) return this.presentationAccepted(true);
    const candidate = this.activeManualPresentation(handle);
    if (!candidate) return this.presentationRejected("presentation_not_presenting");
    await this.recordImpression(candidate);
    state.impressionRecorded = true;
    return this.presentationAccepted(false);
  }

  async reportExperienceAction(
    handle: string,
    actionId: string,
  ): Promise<ExperiencePresentationResult> {
    const unavailable = this.manualPresentationUnavailable();
    if (unavailable) return unavailable;
    const state = this.manualPresentations.get(handle);
    if (!state) return this.presentationRejected("presentation_not_found");
    if (state.actions.has(actionId) || this.reportedActionHandles.has(`${handle}:${actionId}`)) {
      return this.presentationAccepted(true);
    }
    const candidate = this.activeManualPresentation(handle);
    if (!candidate) return this.presentationRejected("presentation_not_presenting");
    const action = findExperienceAction(candidate, actionId);
    if (!action) return this.presentationRejected("invalid_action");
    const actionHandle = `${handle}:${actionId}`;
    state.actions.add(actionId);
    this.reportedActionHandles.add(actionHandle);
    await this.record(candidate, action.primary ? "primary_action" : "secondary_action", {
      actionId,
    });
    return this.presentationAccepted(false);
  }

  async dismissExperience(
    handle: string,
    outcome: ExperienceDismissal = {},
  ): Promise<ExperiencePresentationResult> {
    const unavailable = this.manualPresentationUnavailable();
    if (unavailable) return unavailable;
    const state = this.manualPresentations.get(handle);
    if (!state) return this.presentationRejected("presentation_not_found");
    if (state.dismissed) return this.presentationAccepted(true);
    const candidate = this.activeManualPresentation(handle);
    if (!candidate) return this.presentationRejected("presentation_not_presenting");
    if (outcome.failureCode && !isValidFailureCode(outcome.failureCode)) {
      return this.presentationRejected("invalid_failure_code");
    }
    state.dismissed = true;
    if (outcome.failureCode) {
      await this.record(candidate, "render_failed", { failureCode: outcome.failureCode });
      this.clearCurrentPresentation();
      this.cooldownUntil = Date.now() + 3_000;
      this.scheduleNextPresentation();
    } else {
      await this.finish(candidate, outcome.reason ?? "dismissed");
    }
    return this.presentationAccepted(false);
  }

  /** @deprecated Use dismissExperience(handle, { failureCode }) instead. */
  async failExperiencePresentation(
    handle: string,
    failureCode: string,
  ): Promise<ExperiencePresentationResult> {
    return this.dismissExperience(handle, { failureCode });
  }

  diagnostics(): ExperienceDiagnostics {
    this.discardExpiredCandidates();
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
        profileConsentGranted: this.dependencies.getProfileConsent(),
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
    this.reportedImpressionHandles.clear();
    this.reportedActionHandles.clear();
  }

  async identityChanged(): Promise<void> {
    // A reset creates a new anonymous actor. Pending interactions must not be
    // delivered under that new identity, or old-user Experiences would be
    // attributed to the next person using the same browser.
    await this.clearRuntimeState(true);
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
    if (this.nextPresentationTimer) clearTimeout(this.nextPresentationTimer);
    this.nextPresentationTimer = undefined;
    this.renderAbortController?.abort();
    this.renderAbortController = undefined;
    this.renderHandle?.dismiss("dismissed", false);
    this.clearCurrentPresentation();
    this.queue = [];
    this.manualPresentations.clear();
    this.manualOfferedHandle = undefined;
    this.reportedImpressionHandles.clear();
    this.reportedActionHandles.clear();
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
      profileConsentGranted: this.dependencies.getProfileConsent(),
      identity: this.requireIdentity(),
      metadata: this.metadata,
      settings: this.settings,
      testDeviceToken: this.testDeviceToken,
    });
    if (!response.signedPayload || !response.keyId || !response.signature) {
      throw new Error("EXPERIENCE_MANIFEST_INVALID");
    }
    const manifest = await verifyExperienceManifestPayload({
      signedPayload: response.signedPayload,
      kid: response.keyId,
      signature: response.signature,
      manifestVerificationKeys: this.dependencies.options.manifestVerificationKeys,
      expectedSourceKey: this.dependencies.sourceKey,
    });
    const expiresAt = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("EXPERIENCE_MANIFEST_INVALID");
    }
    this.manifest = manifest;
    this.manifestLoadedAt = Date.now();
    this.lastErrorCode = null;
    return this.manifest;
  }

  private async acceptManifestCampaign(
    campaign: ManifestCampaign,
    context: RuntimeContext,
    manifestExpiresAt: number,
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
    const exposureId = createUuid();
    await this.enqueueCandidate(
      {
        campaignId: campaign.campaignId,
        campaignVersionId: campaign.campaignVersionId,
        assignmentId: assignment.assignmentId,
        variantId: assignment.variantId,
        // The manual callback exposes only this opaque handle, which maps to
        // the exposure ID. No grant or exposure data is exposed in content.
        presentationHandle: exposureId,
        exposureId,
        placement: campaign.placement,
        priority: campaign.priority,
        content: variant.content,
        ...(variant.asset?.url ? { assetUrl: variant.asset.url } : {}),
        grant: campaign.grant,
        defaultLocale: campaign.defaultLocale,
        eligibleAt: Date.now(),
        manifestExpiresAt,
        ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
      },
      context,
    );
  }

  private async acceptDecisions(
    decisions: ExperienceDecision[],
    context: RuntimeContext,
    manifestExpiresAt: number,
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
      const exposureId = createUuid();
      await this.enqueueCandidate(
        {
          campaignId: decision.campaignId,
          campaignVersionId: decision.campaignVersionId,
          assignmentId: decision.assignmentId,
          variantId: decision.variantId,
          presentationHandle: exposureId,
          exposureId,
          placement: decision.placement,
          priority: decision.priority,
          content: decision.content.content,
          ...(decision.content.asset?.url ? { assetUrl: decision.content.asset.url } : {}),
          grant: decision.grant,
          defaultLocale: "en",
          eligibleAt: Date.now(),
          manifestExpiresAt,
          ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
        },
        context,
      );
    }
  }

  private async enqueueCandidate(candidate: QueuedExperience, context: RuntimeContext) {
    if (this.isCandidateExpired(candidate)) return;
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
    this.sortQueue();
    if (this.queue.length > MAX_CANDIDATES) this.queue.length = MAX_CANDIDATES;
    if (!this.queue.some((item) => item.presentationHandle === candidate.presentationHandle)) {
      return;
    }
    await this.record(candidate, "queued");
    if (this.dependencies.options.renderMode === "manual") {
      this.rememberManualPresentation(candidate);
      this.offerNextManualCandidate();
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
    if (this.reportedImpressionHandles.has(experience.presentationHandle)) return;
    this.reportedImpressionHandles.add(experience.presentationHandle);
    this.sessionImpressions += 1;
    await this.record(experience, "impression");
  }

  private async finish(experience: QueuedExperience, reason: "dismissed" | "auto_closed") {
    if (this.suppressInteractionCallbacks) return;
    if (this.current?.exposureId !== experience.exposureId) return;
    await this.record(experience, reason);
    this.clearCurrentPresentation();
    this.cooldownUntil = Date.now() + 3_000;
    this.scheduleNextPresentation();
  }

  private async handleAction(experience: QueuedExperience, action: ExperienceAction) {
    if (!this.isActionAllowed(action)) {
      this.lastErrorCode = "EXPERIENCE_ACTION_NOT_ALLOWED";
      return;
    }
    let handled = false;
    for (const handler of this.actionHandlers) {
      try {
        handled =
          (await handler({ experience: toPublicExperience(experience), action, handled })) ===
            true || handled;
      } catch (error) {
        this.handleError(error);
      }
    }
    if (!handled && action.type === "CUSTOM_CALLBACK") {
      // A callback target is an opaque host-app contract. An allowlist alone
      // must never make the SDK claim it ran a callback: retain the surface so
      // the host can register a handler or let the user dismiss it.
      this.lastErrorCode = "EXPERIENCE_CALLBACK_UNHANDLED";
      return;
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
        return false;
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
          if (parsed.protocol !== "https:" && isUnsafeDeepLinkScheme(scheme)) return false;
          return parsed.protocol === "https:"
            ? this.isAllowedHttpsDeepLink(parsed)
            : this.dependencies.options.allowedDeepLinkSchemes.includes(scheme);
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
      if (parsed.protocol !== "https:" && isUnsafeDeepLinkScheme(scheme)) return false;
      const allowed =
        parsed.protocol === "https:"
          ? this.isAllowedHttpsDeepLink(parsed)
          : this.dependencies.options.allowedDeepLinkSchemes.includes(scheme);
      if (!allowed) return false;
      window.location.assign(parsed.href);
      return true;
    } catch {
      return false;
    }
  }

  private isAllowedHttpsDeepLink(target: URL): boolean {
    return (
      !target.username &&
      !target.password &&
      !target.port &&
      this.dependencies.options.allowedDeepLinkHosts.includes(target.hostname.toLowerCase())
    );
  }

  private manualPresentationUnavailable(): ExperiencePresentationResult | undefined {
    if (this.destroyed) return this.presentationRejected("destroyed");
    if (!this.dependencies.options.enabled) return this.presentationRejected("feature_disabled");
    if (this.dependencies.options.renderMode !== "manual") {
      return this.presentationRejected("manual_mode_required");
    }
    if (!this.canEvaluate()) return this.presentationRejected("consent_required");
    return undefined;
  }

  private activeManualPresentation(handle: string): QueuedExperience | undefined {
    const state = this.manualPresentations.get(handle);
    if (!state?.rendered || state.dismissed) return undefined;
    return this.current?.presentationHandle === handle ? this.current : undefined;
  }

  private rememberManualPresentation(candidate: QueuedExperience): void {
    this.manualPresentations.set(candidate.presentationHandle, {
      rendered: false,
      impressionRecorded: false,
      dismissed: false,
      actions: new Set<string>(),
    });
    while (this.manualPresentations.size > MAX_MANUAL_PRESENTATION_HISTORY) {
      const oldest = this.manualPresentations.keys().next().value;
      if (!oldest) break;
      this.manualPresentations.delete(oldest);
    }
  }

  private offerNextManualCandidate(): void {
    this.discardExpiredCandidates();
    if (
      this.destroyed ||
      this.dependencies.options.renderMode !== "manual" ||
      !this.canEvaluate() ||
      this.current ||
      Date.now() < this.cooldownUntil ||
      this.availableHandlers.size === 0
    ) {
      return;
    }
    this.discardOverCapOverlayCandidates();
    const candidate = this.queue[0];
    if (!candidate || this.manualOfferedHandle === candidate.presentationHandle) return;
    const state = this.manualPresentations.get(candidate.presentationHandle);
    if (!state || state.dismissed) return;
    this.manualOfferedHandle = candidate.presentationHandle;
    const presentation: WtsExperienceManualPresentation = {
      experience: toPublicExperience(candidate),
      handle: candidate.presentationHandle,
    };
    for (const handler of this.availableHandlers) {
      this.notifyAvailableHandler(handler, presentation);
    }
  }

  private notifyAvailableHandler(
    handler: ExperienceAvailableHandler,
    presentation: WtsExperienceManualPresentation,
  ): void {
    try {
      void Promise.resolve(handler(presentation)).catch(() => this.handleManualHandlerError());
    } catch {
      this.handleManualHandlerError();
    }
  }

  private scheduleNextPresentation(): void {
    if (this.nextPresentationTimer) clearTimeout(this.nextPresentationTimer);
    this.nextPresentationTimer = setTimeout(() => {
      this.nextPresentationTimer = undefined;
      if (this.dependencies.options.renderMode === "automatic") {
        void this.presentNext();
      } else {
        this.offerNextManualCandidate();
      }
    }, 3_000);
  }

  private canAdmitOverlay(candidate: QueuedExperience): boolean {
    return !isOverlayPlacement(candidate.placement) || this.sessionOverlays < MAX_SESSION_OVERLAYS;
  }

  private admitOverlay(candidate: QueuedExperience): void {
    if (isOverlayPlacement(candidate.placement)) this.sessionOverlays += 1;
  }

  private discardOverCapOverlayCandidates(): void {
    while (this.queue[0] && !this.canAdmitOverlay(this.queue[0])) {
      const candidate = this.queue.shift()!;
      const state = this.manualPresentations.get(candidate.presentationHandle);
      if (state) state.dismissed = true;
      if (this.manualOfferedHandle === candidate.presentationHandle) {
        this.manualOfferedHandle = undefined;
      }
    }
  }

  private discardExpiredCandidates(): Set<string> {
    const expiredHandles = new Set<string>();
    const now = Date.now();
    this.queue = this.queue.filter((candidate) => {
      if (!this.isCandidateExpired(candidate, now)) return true;
      expiredHandles.add(candidate.presentationHandle);
      const state = this.manualPresentations.get(candidate.presentationHandle);
      if (state) state.dismissed = true;
      if (this.manualOfferedHandle === candidate.presentationHandle) {
        this.manualOfferedHandle = undefined;
      }
      return false;
    });
    return expiredHandles;
  }

  private isCandidateExpired(candidate: QueuedExperience, now = Date.now()): boolean {
    return !Number.isFinite(candidate.manifestExpiresAt) || candidate.manifestExpiresAt <= now;
  }

  private sortQueue(): void {
    this.queue.sort(compareQueued);
    if (!this.manualOfferedHandle) return;
    const offeredIndex = this.queue.findIndex(
      (item) => item.presentationHandle === this.manualOfferedHandle,
    );
    if (offeredIndex < 0) {
      this.manualOfferedHandle = undefined;
      return;
    }
    if (offeredIndex > 0) {
      const [offered] = this.queue.splice(offeredIndex, 1);
      if (offered) this.queue.unshift(offered);
    }
  }

  private presentationAccepted(idempotent: boolean): ExperiencePresentationResult {
    return { accepted: true, idempotent };
  }

  private presentationRejected(
    code: NonNullable<ExperiencePresentationResult["code"]>,
  ): ExperiencePresentationResult {
    return { accepted: false, idempotent: false, code };
  }

  private clearCurrentPresentation() {
    this.current = undefined;
    this.renderHandle = undefined;
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
    if (this.nextPresentationTimer) clearTimeout(this.nextPresentationTimer);
    this.nextPresentationTimer = undefined;
    this.suppressInteractionCallbacks = true;
    this.renderAbortController?.abort();
    this.renderAbortController = undefined;
    this.renderHandle?.dismiss("dismissed", false);
    this.clearCurrentPresentation();
    this.queue = [];
    this.manualPresentations.clear();
    this.manualOfferedHandle = undefined;
    this.reportedImpressionHandles.clear();
    this.reportedActionHandles.clear();
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

  private handleManualHandlerError(): void {
    this.lastErrorCode = "EXPERIENCE_MANUAL_HANDLER_FAILED";
    safeWarn(this.dependencies.debug, "Experience manual presentation handler failed.");
  }

  private canEvaluate(): boolean {
    return (
      !this.destroyed &&
      this.dependencies.options.enabled &&
      this.dependencies.getAnalyticsConsent() === "granted" &&
      (this.consent === "contextual" || this.consent === "personalized") &&
      (this.consent !== "personalized" || this.dependencies.getProfileConsent()) &&
      (this.consent !== "personalized" || this.dependencies.getProfileIdentityReady()) &&
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

function toPublicExperience(candidate: QueuedExperience): WtsExperience {
  return {
    campaignId: candidate.campaignId,
    campaignVersionId: candidate.campaignVersionId,
    assignmentId: candidate.assignmentId,
    variantId: candidate.variantId,
    placement: candidate.placement,
    priority: candidate.priority,
    content: candidate.content,
    ...(candidate.assetUrl ? { assetUrl: candidate.assetUrl } : {}),
  };
}

function selectLocalizedContent(
  translations: WtsExperience["content"]["translations"],
  requestedLocale: string,
) {
  return (
    translations[requestedLocale] ??
    translations[requestedLocale.split("-")[0] ?? ""] ??
    Object.values(translations)[0]
  );
}

function findExperienceAction(experience: QueuedExperience, actionId: string) {
  for (const content of Object.values(experience.content.translations)) {
    if (content.primaryAction?.id === actionId) return { primary: true };
    if (content.secondaryAction?.id === actionId) return { primary: false };
  }
  return undefined;
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

function isOverlayPlacement(placement: QueuedExperience["placement"]): boolean {
  return placement === "modal" || placement === "slide_in" || placement === "bottom_sheet";
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isValidFailureCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}
