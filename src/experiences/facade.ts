import { createUuid, safeWarn } from "../runtime";
import type {
  ExperienceActionHandler,
  ExperienceAvailableHandler,
  ExperienceConsentResult,
  ExperienceConsentState,
  ExperienceContext,
  ExperienceDiagnostics,
  ExperienceDismissal,
  ExperiencePresentationResult,
} from "../types";
import { loadExperienceRuntime } from "@wts/experience-loader";
import type { ExperienceRuntime, ExperienceRuntimeDependencies } from "./runtime";

/**
 * A small, synchronous public facade around the lazy Experience runtime.
 *
 * Analytics consumers pay no Experience implementation cost until the feature
 * is explicitly enabled. Handlers registered before the module loads are
 * retained and attached once, so the public client surface stays stable.
 */
export class ExperienceFacade {
  private runtime: ExperienceRuntime | undefined;
  private loading: Promise<ExperienceRuntime> | undefined;
  private consent: ExperienceConsentState = "pending";
  private consentRevision = 0;
  private destroyed = false;
  private lastErrorCode: string | null = null;
  private readonly actionHandlers = new Map<ExperienceActionHandler, () => void>();
  private readonly availableHandlers = new Map<ExperienceAvailableHandler, () => void>();
  private readonly testDeviceToken = createUuid();

  constructor(private readonly dependencies: ExperienceRuntimeDependencies) {}

  async setConsent(consent: ExperienceConsentState): Promise<ExperienceConsentResult> {
    if (this.destroyed) return { accepted: false, reason: "destroyed" };
    if (!this.dependencies.options.enabled) return { accepted: false, reason: "feature_disabled" };
    if (consent === "contextual" || consent === "personalized") {
      if (this.dependencies.getAnalyticsConsent() !== "granted") {
        return { accepted: false, reason: "analytics_consent_required" };
      }
      if (
        consent === "personalized" &&
        (!this.dependencies.getProfileConsent() || !this.dependencies.getIdentity())
      ) {
        return { accepted: false, reason: "profile_consent_required" };
      }
    }
    const revision = ++this.consentRevision;
    this.consent = consent;
    if (consent === "pending" || consent === "denied") {
      const runtime = this.runtime;
      if (runtime) return runtime.setConsent(consent);
      this.applyDeferredConsent(consent, revision);
      return { accepted: true };
    }
    const runtime = await this.runtimeForActiveOperation();
    if (!runtime || revision !== this.consentRevision) return { accepted: true };
    return runtime.setConsent(consent);
  }

  async profileConsentChanged(): Promise<void> {
    if (!this.dependencies.getProfileConsent() && this.consent === "personalized") {
      const revision = ++this.consentRevision;
      this.consent = "pending";
      this.applyDeferredConsent("pending", revision);
    }
    await this.runtime?.profileConsentChanged();
  }

  async evaluate(context: ExperienceContext): Promise<void> {
    if (this.consent !== "contextual" && this.consent !== "personalized") return;
    const runtime = await this.runtimeForActiveOperation();
    if (!runtime) return;
    if (runtime.diagnostics().consent !== this.consent) await runtime.setConsent(this.consent);
    await runtime.evaluate(context);
  }

  onAction(handler: ExperienceActionHandler): () => void {
    const unsubscribe = this.runtime?.onAction(handler);
    if (unsubscribe) this.actionHandlers.set(handler, unsubscribe);
    else this.actionHandlers.set(handler, () => undefined);
    return () => {
      this.actionHandlers.get(handler)?.();
      this.actionHandlers.delete(handler);
    };
  }

  onAvailable(handler: ExperienceAvailableHandler): () => void {
    const unsubscribe = this.runtime?.onAvailable(handler);
    if (unsubscribe) this.availableHandlers.set(handler, unsubscribe);
    else this.availableHandlers.set(handler, () => undefined);
    return () => {
      this.availableHandlers.get(handler)?.();
      this.availableHandlers.delete(handler);
    };
  }

  async acknowledgeExperienceRender(handle: string): Promise<ExperiencePresentationResult> {
    const runtime = await this.runtimeForManualPresentation();
    return runtime
      ? runtime.acknowledgeExperienceRender(handle)
      : this.manualPresentationUnavailable();
  }

  async acknowledgeExperienceImpression(handle: string): Promise<ExperiencePresentationResult> {
    const runtime = await this.runtimeForManualPresentation();
    return runtime
      ? runtime.acknowledgeExperienceImpression(handle)
      : this.manualPresentationUnavailable();
  }

  async reportExperienceAction(
    handle: string,
    actionId: string,
  ): Promise<ExperiencePresentationResult> {
    const runtime = await this.runtimeForManualPresentation();
    return runtime
      ? runtime.reportExperienceAction(handle, actionId)
      : this.manualPresentationUnavailable();
  }

  async dismissExperience(
    handle: string,
    outcome?: ExperienceDismissal,
  ): Promise<ExperiencePresentationResult> {
    const runtime = await this.runtimeForManualPresentation();
    return runtime
      ? runtime.dismissExperience(handle, outcome)
      : this.manualPresentationUnavailable();
  }

  async failExperiencePresentation(
    handle: string,
    failureCode: string,
  ): Promise<ExperiencePresentationResult> {
    return this.dismissExperience(handle, { failureCode });
  }

  async presentNext(): Promise<boolean> {
    if (this.dependencies.options.renderMode !== "automatic") return false;
    const runtime = await this.runtimeForActiveOperation();
    return runtime ? runtime.presentNext() : false;
  }

  async dismissCurrent(): Promise<boolean> {
    const runtime = await this.runtimeForActiveOperation();
    return runtime ? runtime.dismissCurrent() : false;
  }

  diagnostics(): ExperienceDiagnostics {
    return (
      this.runtime?.diagnostics() ?? {
        enabled: this.dependencies.options.enabled,
        consent: this.consent,
        renderMode: this.dependencies.options.renderMode,
        manifestVersion: null,
        manifestExpiresAt: null,
        queued: 0,
        presenting: false,
        sessionImpressions: 0,
        testDeviceToken: this.testDeviceToken,
        lastErrorCode: this.lastErrorCode,
      }
    );
  }

  async flushInteractions(): Promise<void> {
    await this.runtime?.flushInteractions();
  }

  async reset(): Promise<void> {
    const revision = ++this.consentRevision;
    this.consent = "pending";
    this.applyDeferredConsent("pending", revision);
    await this.runtime?.reset();
  }

  async identityChanged(): Promise<void> {
    await this.runtime?.identityChanged();
  }

  destroy(): void {
    this.destroyed = true;
    this.consentRevision += 1;
    for (const unsubscribe of this.actionHandlers.values()) unsubscribe();
    for (const unsubscribe of this.availableHandlers.values()) unsubscribe();
    this.actionHandlers.clear();
    this.availableHandlers.clear();
    this.runtime?.destroy();
    void this.loading?.then((runtime) => runtime.destroy()).catch(() => undefined);
  }

  private async runtimeForActiveOperation(): Promise<ExperienceRuntime | undefined> {
    if (!this.dependencies.options.enabled || this.destroyed) return undefined;
    if (this.consent === "pending" || this.consent === "denied") return this.runtime;
    return this.loadRuntime();
  }

  private async runtimeForManualPresentation(): Promise<ExperienceRuntime | undefined> {
    const unavailable = this.manualPresentationPrecondition();
    if (unavailable) return undefined;
    return this.loadRuntime();
  }

  private manualPresentationPrecondition(): ExperiencePresentationResult | undefined {
    if (this.destroyed) return { accepted: false, idempotent: false, code: "destroyed" };
    if (!this.dependencies.options.enabled) {
      return { accepted: false, idempotent: false, code: "feature_disabled" };
    }
    if (this.dependencies.options.renderMode !== "manual") {
      return { accepted: false, idempotent: false, code: "manual_mode_required" };
    }
    if (this.consent !== "contextual" && this.consent !== "personalized") {
      return { accepted: false, idempotent: false, code: "consent_required" };
    }
    return undefined;
  }

  private manualPresentationUnavailable(): ExperiencePresentationResult {
    return (
      this.manualPresentationPrecondition() ?? {
        accepted: false,
        idempotent: false,
        code: "presentation_not_found",
      }
    );
  }

  private async loadRuntime(): Promise<ExperienceRuntime | undefined> {
    if (this.runtime) return this.runtime;
    if (!this.loading) {
      const input: ExperienceRuntimeDependencies = {
        ...this.dependencies,
        testDeviceToken: this.testDeviceToken,
      };
      const pending = loadExperienceRuntime(input)
        .then((runtime) => {
          if (this.destroyed) {
            runtime.destroy();
            return runtime;
          }
          this.runtime = runtime;
          this.attachHandlers(runtime);
          return runtime;
        })
        .catch((error: unknown) => {
          this.lastErrorCode = "EXPERIENCE_MODULE_UNAVAILABLE";
          safeWarn(this.dependencies.debug, "Experiences module could not be loaded.");
          throw error;
        });
      this.loading = pending;
      void pending
        .finally(() => {
          if (this.loading === pending) this.loading = undefined;
        })
        .catch(() => undefined);
    }
    try {
      return await this.loading;
    } catch {
      return undefined;
    }
  }

  private attachHandlers(runtime: ExperienceRuntime): void {
    for (const handler of this.actionHandlers.keys()) {
      this.actionHandlers.set(handler, runtime.onAction(handler));
    }
    for (const handler of this.availableHandlers.keys()) {
      this.availableHandlers.set(handler, runtime.onAvailable(handler));
    }
  }

  private applyDeferredConsent(consent: "pending" | "denied", revision: number): void {
    void this.loading
      ?.then((runtime) => {
        if (!this.destroyed && this.consentRevision === revision) {
          return runtime.setConsent(consent);
        }
        return undefined;
      })
      .catch(() => undefined);
  }
}
