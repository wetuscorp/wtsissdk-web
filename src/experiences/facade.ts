import { createUuid, safeWarn } from "../runtime";
import type {
  ConsentState,
  ExperienceActionHandler,
  ExperienceContext,
  ExperienceDiagnostics,
  TestSessionExperienceDecision,
} from "../types";
import { loadExperienceRuntime } from "@wts/experience-loader";
import type { ExperienceRuntime, ExperienceRuntimeDependencies } from "./runtime";

/** Synchronous public facade that preserves lazy loading for Experiences code. */
export class ExperienceFacade {
  private runtime: ExperienceRuntime | undefined;
  private loading: Promise<ExperienceRuntime> | undefined;
  private consent: ConsentState = "pending";
  private consentRevision = 0;
  private destroyed = false;
  private lastErrorCode: string | null = null;
  private readonly actionHandlers = new Map<ExperienceActionHandler, () => void>();
  private readonly testDeviceToken = createUuid();

  constructor(private readonly dependencies: ExperienceRuntimeDependencies) {}

  async setConsent(consent: ConsentState): Promise<void> {
    if (this.destroyed) return;
    const revision = ++this.consentRevision;
    this.consent = consent;
    if (consent !== "granted") {
      if (this.runtime) await this.runtime.setConsent(consent);
      else this.applyDeferredConsent(consent, revision);
      return;
    }
    const runtime = await this.loadRuntime();
    if (runtime && revision === this.consentRevision) await runtime.setConsent("granted");
  }

  evaluate(context: ExperienceContext): void {
    if (this.consent !== "granted" || this.destroyed) return;
    void this.loadRuntime().then((runtime) => {
      if (!runtime || this.consent !== "granted" || this.destroyed) return;
      if (runtime.diagnostics().consent !== "granted") void runtime.setConsent("granted");
      runtime.evaluate(context);
    });
  }

  onAction(handler: ExperienceActionHandler): () => void {
    const unsubscribe = this.runtime?.onAction(handler);
    this.actionHandlers.set(handler, unsubscribe ?? (() => undefined));
    return () => {
      this.actionHandlers.get(handler)?.();
      this.actionHandlers.delete(handler);
    };
  }

  async dismissCurrent(): Promise<boolean> {
    return this.runtime?.dismissCurrent() ?? false;
  }

  async presentTestExperience(
    decision: TestSessionExperienceDecision,
    onInteraction: (interaction: "impression" | "action") => void,
  ): Promise<boolean> {
    const runtime = await this.loadRuntime();
    return runtime?.presentTestExperience(decision, onInteraction) ?? false;
  }

  diagnostics(): ExperienceDiagnostics {
    return (
      this.runtime?.diagnostics() ?? {
        enabled: true,
        consent: this.consent,
        decisionMode: null,
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
    await this.runtime?.reset();
  }

  async identityChanged(): Promise<void> {
    await this.runtime?.identityChanged();
  }

  destroy(): void {
    this.destroyed = true;
    this.consentRevision += 1;
    for (const unsubscribe of this.actionHandlers.values()) unsubscribe();
    this.actionHandlers.clear();
    this.runtime?.destroy();
    void this.loading?.then((runtime) => runtime.destroy()).catch(() => undefined);
  }

  private async loadRuntime(): Promise<ExperienceRuntime | undefined> {
    if (this.runtime) return this.runtime;
    if (this.destroyed || this.consent !== "granted") return undefined;
    if (!this.loading) {
      const input: ExperienceRuntimeDependencies = {
        ...this.dependencies,
        testDeviceToken: this.testDeviceToken,
      };
      const pending = loadExperienceRuntime(input)
        .then((runtime) => {
          if (this.destroyed) runtime.destroy();
          else {
            this.runtime = runtime;
            for (const handler of this.actionHandlers.keys()) {
              this.actionHandlers.set(handler, runtime.onAction(handler));
            }
          }
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

  private applyDeferredConsent(consent: Exclude<ConsentState, "granted">, revision: number): void {
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
