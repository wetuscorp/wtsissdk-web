import type { ExperienceRuntime, ExperienceRuntimeDependencies } from "./runtime";

type ExperienceRuntimeFactory = {
  create(input: ExperienceRuntimeDependencies): ExperienceRuntime;
};

type ExperienceWindow = Window & {
  __wtsWebAssetBaseUrl?: string;
  __wtsWebAssetIntegrity?: {
    experiences?: string;
  };
  __wtsWebExperiencesFactory?: ExperienceRuntimeFactory;
  /** Ephemeral identity token passed only to the companion loaded by this module. */
  __wtsWebExperiencesLoadProof?: object;
  /** Set by the verified companion after it consumes the matching load proof. */
  __wtsWebExperiencesFactoryProof?: object;
};

const EXPERIENCES_ASSET = "wts-web-experiences.iife.min.js";
let verifiedFactoryLoader: Promise<ExperienceRuntimeFactory> | undefined;

export async function loadExperienceRuntime(
  input: ExperienceRuntimeDependencies,
): Promise<ExperienceRuntime> {
  const factory = await loadFactory();
  return factory.create(input);
}

function loadFactory(): Promise<ExperienceRuntimeFactory> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));
  }
  const host = window as ExperienceWindow;
  // The companion is executable code, not data. Never inject it unless the
  // primary versioned IIFE supplied an exact SHA-384 pin for this release.
  // A factory already on `window` could have come from an unpinned or a
  // different-version companion. Only this module's SRI-backed load may make
  // a factory trusted.
  const integrity = host.__wtsWebAssetIntegrity?.experiences;
  if (!isSha384Sri(integrity)) {
    return Promise.reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));
  }
  if (verifiedFactoryLoader) return verifiedFactoryLoader;

  const baseUrl = resolveAssetBaseUrl(host);
  if (!baseUrl) return Promise.reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));

  const loadProof = {};
  try {
    Object.defineProperty(host, "__wtsWebExperiencesLoadProof", {
      value: loadProof,
      writable: false,
      configurable: true,
    });
  } catch {
    return Promise.reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));
  }

  const pending = new Promise<ExperienceRuntimeFactory>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = new URL(EXPERIENCES_ASSET, baseUrl).toString();
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.dataset.wtsWebExperiences = "true";
    script.onload = () => {
      const factory = host.__wtsWebExperiencesFactory;
      if (factory && host.__wtsWebExperiencesFactoryProof === loadProof) resolve(factory);
      else reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));
    };
    script.onerror = () => reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));
    document.head.append(script);
  });
  verifiedFactoryLoader = pending;
  void pending
    .catch(() => {
      if (verifiedFactoryLoader === pending) verifiedFactoryLoader = undefined;
    })
    .finally(() => {
      if (host.__wtsWebExperiencesLoadProof === loadProof) {
        delete host.__wtsWebExperiencesLoadProof;
      }
    });
  return pending;
}

function isSha384Sri(value: unknown): value is string {
  return typeof value === "string" && /^sha384-[A-Za-z0-9+/]{64}$/.test(value);
}

function resolveAssetBaseUrl(host: ExperienceWindow): string | undefined {
  if (host.__wtsWebAssetBaseUrl) return host.__wtsWebAssetBaseUrl;
  const script = Array.from(document.scripts).find((candidate) =>
    candidate.src.includes("wts-web.iife.min.js"),
  );
  if (!script?.src) return undefined;
  return new URL(".", script.src).toString();
}
