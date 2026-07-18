import type { ExperienceRuntime, ExperienceRuntimeDependencies } from "./runtime";

type ExperienceRuntimeFactory = {
  create(input: ExperienceRuntimeDependencies): ExperienceRuntime;
};

type ExperienceWindow = Window & {
  __wtsWebAssetBaseUrl?: string;
  __wtsWebExperiencesFactory?: ExperienceRuntimeFactory;
  __wtsWebExperiencesLoader?: Promise<ExperienceRuntimeFactory>;
};

const EXPERIENCES_ASSET = "wts-web-experiences.iife.min.js";

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
  if (host.__wtsWebExperiencesFactory) return Promise.resolve(host.__wtsWebExperiencesFactory);
  if (host.__wtsWebExperiencesLoader) return host.__wtsWebExperiencesLoader;

  const baseUrl = resolveAssetBaseUrl(host);
  if (!baseUrl) return Promise.reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));

  const pending = new Promise<ExperienceRuntimeFactory>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = new URL(EXPERIENCES_ASSET, baseUrl).toString();
    script.dataset.wtsWebExperiences = "true";
    script.onload = () => {
      const factory = host.__wtsWebExperiencesFactory;
      if (factory) resolve(factory);
      else reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));
    };
    script.onerror = () => reject(new Error("EXPERIENCE_MODULE_UNAVAILABLE"));
    document.head.append(script);
  });
  host.__wtsWebExperiencesLoader = pending;
  return pending;
}

function resolveAssetBaseUrl(host: ExperienceWindow): string | undefined {
  if (host.__wtsWebAssetBaseUrl) return host.__wtsWebAssetBaseUrl;
  const script = Array.from(document.scripts).find((candidate) =>
    candidate.src.includes("wts-web.iife.min.js"),
  );
  if (!script?.src) return undefined;
  return new URL(".", script.src).toString();
}
