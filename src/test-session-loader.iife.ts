import type { TestSessionRuntime, TestSessionRuntimeInput } from "./test-session";

type TestSessionRuntimeFactory = {
  create(input: TestSessionRuntimeInput): TestSessionRuntime;
};

type TestSessionWindow = Window & {
  __wtsWebAssetBaseUrl?: string;
  __wtsWebTestSessionFactory?: TestSessionRuntimeFactory;
  __wtsWebTestSessionLoader?: Promise<TestSessionRuntimeFactory>;
};

const TEST_SESSION_ASSET = "wts-web-test-session.iife.min.js";

export async function loadTestSessionRuntime(
  input: TestSessionRuntimeInput,
): Promise<TestSessionRuntime> {
  const factory = await loadFactory();
  return factory.create(input);
}

function loadFactory(): Promise<TestSessionRuntimeFactory> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("TEST_SESSION_MODULE_UNAVAILABLE"));
  }
  const host = window as TestSessionWindow;
  if (host.__wtsWebTestSessionFactory) return Promise.resolve(host.__wtsWebTestSessionFactory);
  if (host.__wtsWebTestSessionLoader) return host.__wtsWebTestSessionLoader;

  const baseUrl = resolveAssetBaseUrl(host);
  if (!baseUrl) return Promise.reject(new Error("TEST_SESSION_MODULE_UNAVAILABLE"));

  const pending = new Promise<TestSessionRuntimeFactory>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = new URL(TEST_SESSION_ASSET, baseUrl).toString();
    script.dataset.wtsWebTestSession = "true";
    script.onload = () => {
      const factory = host.__wtsWebTestSessionFactory;
      if (factory) resolve(factory);
      else reject(new Error("TEST_SESSION_MODULE_UNAVAILABLE"));
    };
    script.onerror = () => reject(new Error("TEST_SESSION_MODULE_UNAVAILABLE"));
    document.head.append(script);
  });
  host.__wtsWebTestSessionLoader = pending;
  return pending;
}

function resolveAssetBaseUrl(host: TestSessionWindow): string | undefined {
  if (host.__wtsWebAssetBaseUrl) return host.__wtsWebAssetBaseUrl;
  const script = Array.from(document.scripts).find((candidate) =>
    candidate.src.includes("wts-web.iife.min.js"),
  );
  if (!script?.src) return undefined;
  return new URL(".", script.src).toString();
}
