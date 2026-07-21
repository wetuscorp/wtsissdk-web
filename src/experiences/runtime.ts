import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, SDK_VERSION } from "../constants";
import { byteLength, createUuid, locale, safeWarn } from "../runtime";
import { TransportError } from "../transport";
import type {
  ConsentState,
  ExperienceAction,
  ExperienceActionHandler,
  ExperienceContext,
  ExperienceDiagnostics,
  ExperienceContent,
  Identity,
  StorageAdapter,
  StoredExperienceManifest,
  TestSessionExperienceDecision,
  WtsExperience,
} from "../types";
import { isUnsafeDeepLinkScheme } from "../validation";
import { verifyExperienceManifestPayload } from "./manifest-verifier";
import type { RenderHandle } from "./renderer";
import { ExperienceTransport } from "./transport";
import type {
  ExperienceDecision,
  ExperienceInteraction,
  ExperienceManifest,
  ManifestCampaign,
  QueuedExperience,
  RuntimeContext,
  TargetNode,
} from "./types";

export interface ExperienceRuntimeDependencies {
  sourceKey: string;
  collectorOrigin: string;
  timeoutMs: number;
  debug: boolean;
  getConsent(): ConsentState;
  getIdentity(): Identity | undefined;
  getStorage(): StorageAdapter | undefined;
  /** Unit-test trust override; release builds use the embedded root. */
  rootPublicKey?: string;
  /** A facade-owned, per-client opaque token for unpublished device tests. */
  testDeviceToken?: string;
  onInteraction?(type: ExperienceInteraction["type"]): void;
}

const REFRESH_INTERVAL_MS = 60_000;
const MAX_CANDIDATES = 5;
const MAX_SESSION_OVERLAYS = 2;
const MAX_SESSION_IMPRESSIONS = 5;
const PRESENTATION_COOLDOWN_MS = 3_000;

export class ExperienceRuntime {
  private consent: ConsentState = "pending";
  private decisionMode: "contextual" | "personalized" | null = null;
  private readonly transport: ExperienceTransport;
  private manifest: ExperienceManifest | undefined;
  private manifestLoadedAt = 0;
  private manifestEtag: string | undefined;
  private cacheLoaded = false;
  private refreshFlight: Promise<boolean> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private queue: QueuedExperience[] = [];
  private current: QueuedExperience | undefined;
  private renderHandle: RenderHandle | undefined;
  private renderAbortController: AbortController | undefined;
  private testRenderHandle: RenderHandle | undefined;
  private testRenderAbortController: AbortController | undefined;
  private nextPresentationTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reportedImpressions = new Set<string>();
  private readonly recordedBranches = new Set<string>();
  private readonly actionHandlers = new Set<ExperienceActionHandler>();
  private readonly sessionCampaignImpressions = new Map<string, number>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
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

  async setConsent(consent: ConsentState): Promise<void> {
    if (this.destroyed) return;
    this.consent = consent;
    if (consent !== "granted") {
      this.stopRefreshLoop();
      await this.clearRuntimeState(true, true);
      return;
    }
    this.startRefreshLoop();
    try {
      await this.loadCachedManifest();
      await this.refreshManifest();
      await this.flushInteractions();
    } catch (error) {
      this.handleError(error);
    }
  }

  onAction(handler: ExperienceActionHandler): () => void {
    this.actionHandlers.add(handler);
    return () => this.actionHandlers.delete(handler);
  }

  evaluate(context: ExperienceContext): void {
    if (!this.canEvaluate()) return;
    void this.evaluateInBackground(context);
  }

  async presentNext(): Promise<boolean> {
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
    if (!isWebPlacement(candidate.placement)) return this.presentNext();
    if (isOverlayPlacement(candidate.placement)) this.sessionOverlays += 1;
    this.current = candidate;
    await this.record(candidate, "render_started");
    const controller = new AbortController();
    this.renderAbortController = controller;
    try {
      const renderer = await import("./renderer");
      const handle = await renderer.renderExperience(candidate, {
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
        handle.dismiss("dismissed", false);
        return false;
      }
      this.renderHandle = handle;
      await this.record(candidate, "render_succeeded");
      return true;
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        if (this.current?.exposureId === candidate.exposureId) this.clearCurrentPresentation();
        return false;
      }
      await this.record(candidate, "render_failed", { failureCode: normalizeErrorCode(error) });
      this.clearCurrentPresentation();
      this.cooldownUntil = Date.now() + PRESENTATION_COOLDOWN_MS;
      this.scheduleNextPresentation();
      this.handleError(error);
      return false;
    } finally {
      if (this.renderAbortController === controller) this.renderAbortController = undefined;
    }
  }

  async dismissCurrent(): Promise<boolean> {
    if (this.testRenderHandle) {
      this.testRenderHandle.dismiss("dismissed");
      this.testRenderHandle = undefined;
      return true;
    }
    if (!this.current || !this.renderHandle) return false;
    this.renderHandle.dismiss("dismissed");
    return true;
  }

  async presentTestExperience(
    decision: TestSessionExperienceDecision,
    onInteraction: (interaction: "impression" | "action") => void,
  ): Promise<boolean> {
    if (
      !this.canEvaluate() ||
      this.current ||
      this.testRenderHandle ||
      decision.outcome !== "ready" ||
      !decision.testGrant ||
      Date.parse(decision.testGrant.expiresAt) <= Date.now() ||
      !decision.decision?.variant ||
      !isWebPlacementValue(decision.decision.placement) ||
      !isExperienceContent(decision.decision.variant.content)
    ) {
      return false;
    }
    const assetUrl = decision.decision.variant.asset?.url;
    const candidate: QueuedExperience = {
      campaignId: decision.decision.campaignId,
      campaignVersionId: decision.decision.campaignVersionId,
      assignmentId: null,
      variantId: decision.decision.variant.id,
      exposureId: createUuid(),
      placement: decision.decision.placement,
      priority: Number.MAX_SAFE_INTEGER,
      content: decision.decision.variant.content,
      ...(safeAssetUrl(assetUrl) ? { assetUrl } : {}),
      grant: "isolated-test-session",
      defaultLocale: decision.decision.defaultLocale,
      eligibleAt: Date.now(),
      manifestExpiresAt: Date.parse(decision.testGrant.expiresAt),
      frequency: { session: 1, daily: 1 },
    };
    const controller = new AbortController();
    this.testRenderAbortController = controller;
    try {
      const renderer = await import("./renderer");
      const handle = await renderer.renderExperience(candidate, {
        locale: this.metadata.locale,
        signal: controller.signal,
        onAction: (action) => {
          void this.handleTestAction(candidate, action, onInteraction);
        },
        onDismiss: () => {
          this.testRenderHandle = undefined;
        },
        onImpression: () => onInteraction("impression"),
      });
      if (controller.signal.aborted || !this.canEvaluate()) {
        handle.dismiss("dismissed", false);
        return false;
      }
      this.testRenderHandle = handle;
      return true;
    } catch (error) {
      if (!isAbortError(error)) this.handleError(error);
      return false;
    } finally {
      if (this.testRenderAbortController === controller) {
        this.testRenderAbortController = undefined;
      }
    }
  }

  diagnostics(): ExperienceDiagnostics {
    this.discardExpiredCandidates();
    return {
      enabled: true,
      consent: this.consent,
      decisionMode: this.decisionMode,
      manifestVersion: this.manifest?.manifestVersion ?? null,
      manifestExpiresAt: this.manifest?.expiresAt ?? null,
      queued: this.queue.length,
      presenting: Boolean(this.current || this.testRenderHandle),
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
        if ((await storage.load()).experienceQueue.length > 0) {
          queueMicrotask(() => void this.flushInteractions());
        }
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
    await this.clearRuntimeState(true, true);
    this.sessionImpressions = 0;
    this.sessionOverlays = 0;
    this.sessionCampaignImpressions.clear();
    if (this.canEvaluate()) {
      this.startRefreshLoop();
      void this.refreshManifest();
    }
  }

  async identityChanged(): Promise<void> {
    // Identity changes must not deliver an old actor's pending interactions
    // under the newly bound or newly anonymous actor.
    await this.clearRuntimeState(true, false);
  }

  destroy(): void {
    this.destroyed = true;
    this.stopRefreshLoop();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.nextPresentationTimer) clearTimeout(this.nextPresentationTimer);
    this.retryTimer = undefined;
    this.nextPresentationTimer = undefined;
    this.abortPresentation();
    this.queue = [];
    this.reportedImpressions.clear();
    this.recordedBranches.clear();
    this.actionHandlers.clear();
  }

  private async evaluateInBackground(context: ExperienceContext): Promise<void> {
    try {
      await this.loadCachedManifest();
      const current = this.validManifest();
      if (current) await this.evaluateContextualManifest(current, context);

      const stale = !current || Date.now() - this.manifestLoadedAt >= REFRESH_INTERVAL_MS;
      if (stale) {
        const refreshed = await this.refreshManifest();
        const latest = this.validManifest();
        if (refreshed && latest) await this.evaluateContextualManifest(latest, context);
      }

      const manifest = this.validManifest();
      if (manifest && this.canEvaluate()) {
        const response = await this.transport.decide({
          identity: this.requireIdentity(),
          metadata: this.metadata,
          testDeviceToken: this.testDeviceToken,
          candidateVersionIds: manifest.campaigns.map((item) => item.campaignVersionId),
          context: {
            ...toRuntimeContext(context),
            trigger: context.trigger,
          },
        });
        this.decisionMode = response.mode;
        await this.acceptDecisions(response.decisions, toRuntimeContext(context), manifest);
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private async evaluateContextualManifest(
    manifest: ExperienceManifest,
    context: ExperienceContext,
  ): Promise<void> {
    const runtimeContext = toRuntimeContext(context);
    const candidates = manifest.campaigns
      .filter((campaign) => !campaign.requiresPersonalization)
      .filter((campaign) => isCampaignActive(campaign))
      .filter((campaign) => triggerMatches(campaign, runtimeContext))
      .filter((campaign) => targetingMatches(campaign.targeting, manifest, this.metadata.locale))
      .sort(compareCampaigns)
      .slice(0, MAX_CANDIDATES);
    const manifestExpiresAt = Date.parse(manifest.expiresAt);
    for (const campaign of candidates) {
      await this.acceptManifestCampaign(campaign, runtimeContext, manifestExpiresAt);
    }
  }

  private async loadCachedManifest(): Promise<void> {
    if (this.cacheLoaded || !this.canEvaluate()) return;
    this.cacheLoaded = true;
    const storage = this.dependencies.getStorage();
    const cached = (await storage?.load())?.experienceManifest;
    if (!cached) return;
    try {
      const manifest = await this.verifyStoredManifest(cached);
      this.manifest = manifest;
      this.manifestEtag = cached.etag;
      this.manifestLoadedAt = Date.parse(cached.cachedAt);
      if (!Number.isFinite(this.manifestLoadedAt)) this.manifestLoadedAt = 0;
    } catch (error) {
      await storage?.saveExperienceManifest();
      this.handleError(error);
    }
  }

  private refreshManifest(): Promise<boolean> {
    if (!this.canEvaluate()) return Promise.resolve(false);
    if (this.refreshFlight) return this.refreshFlight;
    const pending = this.performManifestRefresh();
    this.refreshFlight = pending;
    void pending
      .finally(() => {
        if (this.refreshFlight === pending) this.refreshFlight = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  private async performManifestRefresh(): Promise<boolean> {
    const response = await this.transport.bootstrap({
      identity: this.requireIdentity(),
      metadata: this.metadata,
      testDeviceToken: this.testDeviceToken,
      ...(this.manifestEtag ? { etag: this.manifestEtag } : {}),
    });
    if (response.notModified) {
      this.manifestLoadedAt = Date.now();
      if (response.etag) this.manifestEtag = response.etag;
      return false;
    }
    const envelope = response.response;
    const cached: StoredExperienceManifest = {
      signedPayload: envelope.signedPayload,
      signature: envelope.signature,
      keyId: envelope.keyId,
      expiresAt: envelope.expiresAt,
      onlineKeyset: envelope.onlineKeyset,
      cachedAt: new Date().toISOString(),
      ...(response.etag ? { etag: response.etag } : {}),
    };
    const manifest = await this.verifyStoredManifest(cached);
    this.manifest = manifest;
    this.manifestLoadedAt = Date.now();
    this.manifestEtag = response.etag;
    this.cacheLoaded = true;
    this.lastErrorCode = null;
    await this.dependencies.getStorage()?.saveExperienceManifest(cached);
    return true;
  }

  private verifyStoredManifest(cached: StoredExperienceManifest): Promise<ExperienceManifest> {
    return verifyExperienceManifestPayload({
      signedPayload: cached.signedPayload,
      kid: cached.keyId,
      signature: cached.signature,
      onlineKeyset: cached.onlineKeyset,
      expectedSourceKey: this.dependencies.sourceKey,
      ...(this.dependencies.rootPublicKey
        ? { rootPublicKey: this.dependencies.rootPublicKey }
        : {}),
    });
  }

  private validManifest(): ExperienceManifest | undefined {
    if (!this.manifest) return undefined;
    if (Date.parse(this.manifest.expiresAt) > Date.now()) return this.manifest;
    this.manifest = undefined;
    this.manifestEtag = undefined;
    void this.dependencies.getStorage()?.saveExperienceManifest();
    this.lastErrorCode = "EXPERIENCE_MANIFEST_EXPIRED";
    return undefined;
  }

  private async acceptManifestCampaign(
    campaign: ManifestCampaign,
    context: RuntimeContext,
    manifestExpiresAt: number,
  ): Promise<void> {
    const assignment = campaign.assignment;
    if (!assignment || !campaign.grant) return;
    if (assignment.kind === "holdout") {
      await this.recordBranch(campaign, assignment.assignmentId, null, campaign.grant, context);
      return;
    }
    const variant = campaign.variants.find((item) => item.id === assignment.variantId);
    if (!variant) return;
    const assetUrl = variant.asset?.url;
    await this.enqueueCandidate({
      campaignId: campaign.campaignId,
      campaignVersionId: campaign.campaignVersionId,
      assignmentId: assignment.assignmentId,
      variantId: assignment.variantId,
      exposureId: createUuid(),
      placement: campaign.placement,
      priority: campaign.priority,
      content: variant.content,
      ...(safeAssetUrl(assetUrl) ? { assetUrl } : {}),
      grant: campaign.grant,
      defaultLocale: campaign.defaultLocale,
      eligibleAt: Date.now(),
      manifestExpiresAt,
      frequency: campaign.frequency,
      ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
    });
  }

  private async acceptDecisions(
    decisions: ExperienceDecision[],
    context: RuntimeContext,
    manifest: ExperienceManifest,
  ): Promise<void> {
    for (const decision of decisions.sort(compareDecisions).slice(0, MAX_CANDIDATES)) {
      if (decision.holdout) {
        await this.recordBranch(decision, decision.assignmentId, null, decision.grant, context);
        continue;
      }
      if (!decision.content) continue;
      const frequency = manifest.campaigns.find(
        (item) => item.campaignVersionId === decision.campaignVersionId,
      )?.frequency ?? { session: 1, daily: 1 };
      const assetUrl = decision.content.asset?.url;
      await this.enqueueCandidate({
        campaignId: decision.campaignId,
        campaignVersionId: decision.campaignVersionId,
        assignmentId: decision.assignmentId,
        variantId: decision.variantId,
        exposureId: createUuid(),
        placement: decision.placement,
        priority: decision.priority,
        content: decision.content.content,
        ...(safeAssetUrl(assetUrl) ? { assetUrl } : {}),
        grant: decision.grant,
        defaultLocale: "en",
        eligibleAt: Date.now(),
        manifestExpiresAt: Date.parse(manifest.expiresAt),
        frequency,
        ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
      });
    }
  }

  private async enqueueCandidate(candidate: QueuedExperience): Promise<void> {
    if (
      this.isCandidateExpired(candidate) ||
      !isWebPlacement(candidate.placement) ||
      !(await this.frequencyAllowed(candidate))
    ) {
      return;
    }
    if (
      this.queue.some((item) => item.campaignVersionId === candidate.campaignVersionId) ||
      this.current?.campaignVersionId === candidate.campaignVersionId
    ) {
      return;
    }
    await this.record(candidate, "assigned_variant");
    await this.record(candidate, "eligible");
    this.queue.push(candidate);
    this.queue.sort(compareQueued);
    if (this.queue.length > MAX_CANDIDATES) this.queue.length = MAX_CANDIDATES;
    if (!this.queue.some((item) => item.exposureId === candidate.exposureId)) return;
    await this.record(candidate, "queued");
    void this.presentNext();
  }

  private async frequencyAllowed(candidate: QueuedExperience): Promise<boolean> {
    const session = this.sessionCampaignImpressions.get(candidate.campaignVersionId) ?? 0;
    if (session >= candidate.frequency.session) return false;
    const ledger = (await this.dependencies.getStorage()?.load())?.experienceImpressions ?? {};
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const daily = (ledger[candidate.campaignVersionId] ?? []).filter(
      (value) => Date.parse(value) > cutoff,
    ).length;
    return daily < candidate.frequency.daily;
  }

  private async recordBranch(
    campaign: Pick<ManifestCampaign, "campaignId" | "campaignVersionId">,
    assignmentId: string,
    variantId: string | null,
    grant: string,
    context: RuntimeContext,
  ): Promise<void> {
    const key = `${campaign.campaignVersionId}:${context.triggerEventId ?? "no-event"}`;
    if (this.recordedBranches.has(key)) return;
    this.recordedBranches.add(key);
    await this.enqueueInteraction(
      this.createInteraction(
        {
          campaignId: campaign.campaignId,
          campaignVersionId: campaign.campaignVersionId,
          assignmentId,
          variantId,
          exposureId: null,
          grant,
          ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
        },
        "assigned_holdout",
      ),
    );
  }

  private async record(
    experience: QueuedExperience,
    type: ExperienceInteraction["type"],
    details: {
      actionId?: string;
      actionOutcome?: "handled" | "unhandled";
      failureCode?: string;
    } = {},
  ): Promise<void> {
    await this.enqueueInteraction(
      this.createInteraction(
        experience,
        type,
        details.actionId,
        details.actionOutcome,
        details.failureCode,
      ),
    );
  }

  private async recordImpression(experience: QueuedExperience): Promise<void> {
    if (this.current?.exposureId !== experience.exposureId) return;
    if (this.reportedImpressions.has(experience.exposureId)) return;
    this.reportedImpressions.add(experience.exposureId);
    this.sessionImpressions += 1;
    this.sessionCampaignImpressions.set(
      experience.campaignVersionId,
      (this.sessionCampaignImpressions.get(experience.campaignVersionId) ?? 0) + 1,
    );
    const occurredAt = new Date().toISOString();
    await this.dependencies
      .getStorage()
      ?.recordExperienceImpression(experience.campaignVersionId, occurredAt);
    await this.record(experience, "impression");
  }

  private async finish(
    experience: QueuedExperience,
    reason: "dismissed" | "auto_closed",
  ): Promise<void> {
    if (this.suppressInteractionCallbacks) return;
    if (this.current?.exposureId !== experience.exposureId) return;
    await this.record(experience, reason);
    this.clearCurrentPresentation();
    this.cooldownUntil = Date.now() + PRESENTATION_COOLDOWN_MS;
    this.scheduleNextPresentation();
  }

  private async handleAction(
    experience: QueuedExperience,
    action: ExperienceAction,
  ): Promise<void> {
    if (this.current?.exposureId !== experience.exposureId) return;
    let handled = false;
    if (isSafeAction(action)) {
      for (const handler of this.actionHandlers) {
        try {
          if ((await handler({ experience: toPublicExperience(experience), action })) === true) {
            handled = true;
          }
        } catch (error) {
          this.handleError(error);
        }
      }
      if (!handled) handled = await this.performDefaultAction(action);
    } else {
      this.lastErrorCode = "EXPERIENCE_ACTION_NOT_ALLOWED";
    }
    const content = selectLocalizedContent(experience.content.translations, this.metadata.locale);
    await this.record(
      experience,
      content?.primaryAction?.id === action.id ? "primary_action" : "secondary_action",
      { actionId: action.id, actionOutcome: handled ? "handled" : "unhandled" },
    );
    // An unhandled advanced action deliberately leaves the Experience open.
    if (handled) this.renderHandle?.dismiss("dismissed");
  }

  private async handleTestAction(
    experience: QueuedExperience,
    action: ExperienceAction,
    onInteraction: (interaction: "impression" | "action") => void,
  ): Promise<void> {
    let handled = false;
    if (isSafeAction(action)) {
      for (const handler of this.actionHandlers) {
        try {
          if ((await handler({ experience: toPublicExperience(experience), action })) === true) {
            handled = true;
          }
        } catch (error) {
          this.handleError(error);
        }
      }
      if (!handled) handled = await this.performDefaultAction(action);
    }
    onInteraction("action");
    if (handled) this.testRenderHandle?.dismiss("dismissed");
  }

  private async performDefaultAction(action: ExperienceAction): Promise<boolean> {
    const target = action.target;
    switch (action.type) {
      case "DISMISS":
        return true;
      case "COPY_CODE":
        if (!target || !globalThis.navigator?.clipboard) return false;
        await globalThis.navigator.clipboard.writeText(target);
        return true;
      case "OPEN_INTERNAL_ROUTE":
      case "CUSTOM_CALLBACK":
        return false;
      case "OPEN_WEB_URL":
      case "OPEN_DEEP_LINK":
        if (!target || typeof window === "undefined") return false;
        window.location.assign(new URL(target).href);
        return true;
    }
  }

  private discardExpiredCandidates(): void {
    const now = Date.now();
    this.queue = this.queue.filter((candidate) => !this.isCandidateExpired(candidate, now));
  }

  private isCandidateExpired(candidate: QueuedExperience, now = Date.now()): boolean {
    return !Number.isFinite(candidate.manifestExpiresAt) || candidate.manifestExpiresAt <= now;
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
    actionOutcome?: "handled" | "unhandled",
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
      actionOutcome: actionOutcome ?? null,
      triggerEventId: experience.triggerEventId ?? null,
      occurredAt: new Date().toISOString(),
      metadata: this.metadata,
      failureCode: failureCode ?? null,
    };
  }

  private async enqueueInteraction(interaction: ExperienceInteraction): Promise<void> {
    const storage = this.dependencies.getStorage();
    if (!storage || !this.canEvaluate()) return;
    await storage.enqueueExperience(interaction);
    this.dependencies.onInteraction?.(interaction.type);
    queueMicrotask(() => void this.flushInteractions());
  }

  private async clearRuntimeState(clearStored: boolean, clearManifest: boolean): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.nextPresentationTimer) clearTimeout(this.nextPresentationTimer);
    this.retryTimer = undefined;
    this.nextPresentationTimer = undefined;
    this.suppressInteractionCallbacks = true;
    this.abortPresentation();
    this.queue = [];
    this.reportedImpressions.clear();
    this.recordedBranches.clear();
    this.decisionMode = null;
    if (clearManifest) {
      this.manifest = undefined;
      this.manifestEtag = undefined;
      this.manifestLoadedAt = 0;
      this.cacheLoaded = false;
    }
    try {
      if (clearStored) {
        const storage = this.dependencies.getStorage();
        const state = await storage?.load();
        if (state) {
          await storage?.removeExperiences(
            new Set(state.experienceQueue.map((item) => item.clientInteractionId)),
          );
          if (clearManifest) await storage?.saveExperienceManifest();
        }
      }
    } finally {
      this.suppressInteractionCallbacks = false;
    }
  }

  private startRefreshLoop(): void {
    if (this.refreshTimer || typeof document === "undefined") return;
    this.refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible" && this.canEvaluate()) {
        void this.refreshManifest().catch((error) => this.handleError(error));
      }
    }, REFRESH_INTERVAL_MS);
  }

  private stopRefreshLoop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private scheduleNextPresentation(): void {
    if (this.nextPresentationTimer) clearTimeout(this.nextPresentationTimer);
    this.nextPresentationTimer = setTimeout(() => {
      this.nextPresentationTimer = undefined;
      void this.presentNext();
    }, PRESENTATION_COOLDOWN_MS);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.canEvaluate()) return;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(this.retryAttempt, 6));
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.flushInteractions();
      },
      base + Math.floor(Math.random() * Math.max(1, base * 0.25)),
    );
  }

  private abortPresentation(): void {
    this.renderAbortController?.abort();
    this.renderAbortController = undefined;
    this.renderHandle?.dismiss("dismissed", false);
    this.testRenderAbortController?.abort();
    this.testRenderAbortController = undefined;
    this.testRenderHandle?.dismiss("dismissed", false);
    this.testRenderHandle = undefined;
    this.clearCurrentPresentation();
  }

  private clearCurrentPresentation(): void {
    this.current = undefined;
    this.renderHandle = undefined;
  }

  private handleError(error: unknown): void {
    this.lastErrorCode = normalizeErrorCode(error);
    safeWarn(this.dependencies.debug, `Experiences request failed (${this.lastErrorCode}).`);
  }

  private canEvaluate(): boolean {
    return (
      !this.destroyed &&
      this.consent === "granted" &&
      this.dependencies.getConsent() === "granted" &&
      Boolean(this.dependencies.getIdentity()) &&
      Boolean(this.dependencies.getStorage())
    );
  }

  private requireIdentity(): Identity {
    const identity = this.dependencies.getIdentity();
    if (!identity) throw new Error("EXPERIENCE_IDENTITY_UNAVAILABLE");
    return identity;
  }

  private get metadata() {
    return { platform: "web" as const, sdkVersion: SDK_VERSION, locale: locale() };
  }
}

function toRuntimeContext(context: ExperienceContext): RuntimeContext {
  return {
    ...(context.pathname ? { pathname: context.pathname } : {}),
    ...(context.pageName ? { pageName: context.pageName } : {}),
    ...(context.eventKey ? { eventKey: context.eventKey } : {}),
    properties: context.properties,
    ...(context.triggerEventId ? { triggerEventId: context.triggerEventId } : {}),
  };
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

function isCampaignActive(campaign: ManifestCampaign): boolean {
  const now = Date.now();
  return (
    (!campaign.startsAt || Date.parse(campaign.startsAt) <= now) &&
    (!campaign.endsAt || Date.parse(campaign.endsAt) > now)
  );
}

function compareCampaigns(left: ManifestCampaign, right: ManifestCampaign): number {
  return right.priority - left.priority || left.campaignId.localeCompare(right.campaignId);
}

function compareDecisions(left: ExperienceDecision, right: ExperienceDecision): number {
  return right.priority - left.priority || left.campaignId.localeCompare(right.campaignId);
}

function compareQueued(left: QueuedExperience, right: QueuedExperience): number {
  return (
    right.priority - left.priority ||
    left.eligibleAt - right.eligibleAt ||
    left.campaignId.localeCompare(right.campaignId)
  );
}

function isWebPlacement(placement: QueuedExperience["placement"]): boolean {
  return ["modal", "top_banner", "bottom_banner", "slide_in"].includes(placement);
}

function isWebPlacementValue(value: string): value is QueuedExperience["placement"] {
  return ["modal", "top_banner", "bottom_banner", "slide_in"].includes(value);
}

function isExperienceContent(value: unknown): value is ExperienceContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const content = value as Partial<ExperienceContent>;
  return (
    Boolean(content.translations) &&
    typeof content.translations === "object" &&
    typeof content.closeable === "boolean" &&
    ["light", "dark", "brand"].includes(String(content.themePreset)) &&
    typeof content.delaySeconds === "number" &&
    (content.autoCloseSeconds === null || typeof content.autoCloseSeconds === "number")
  );
}

function isOverlayPlacement(placement: QueuedExperience["placement"]): boolean {
  return placement === "modal" || placement === "slide_in";
}

function safeAssetUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeAction(action: ExperienceAction): boolean {
  const target = action.target;
  if (action.type === "DISMISS") return true;
  if (action.type === "COPY_CODE") return Boolean(target);
  if (action.type === "OPEN_INTERNAL_ROUTE" || action.type === "CUSTOM_CALLBACK") {
    return Boolean(target);
  }
  if (!target) return false;
  try {
    const parsed = new URL(target);
    if (parsed.username || parsed.password) return false;
    if (action.type === "OPEN_WEB_URL") return parsed.protocol === "https:";
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    return (
      parsed.protocol === "https:" ||
      (/^[a-z][a-z0-9+.-]*$/.test(scheme) && !isUnsafeDeepLinkScheme(scheme))
    );
  } catch {
    return false;
  }
}

function takeInteractionBatch(queue: ExperienceInteraction[]): ExperienceInteraction[] {
  const batch: ExperienceInteraction[] = [];
  for (const interaction of queue.slice(0, MAX_BATCH_EVENTS)) {
    if (byteLength({ schemaVersion: 2, interactions: [...batch, interaction] }) > MAX_BATCH_BYTES) {
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
