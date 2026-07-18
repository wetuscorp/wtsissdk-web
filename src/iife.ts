import { createWtsClient } from "./index";

const api = { createWtsClient };

if (typeof window !== "undefined") {
  const currentScript = document.currentScript as HTMLScriptElement | null;
  if (currentScript?.src) {
    Object.defineProperty(window, "__wtsWebAssetBaseUrl", {
      value: new URL(".", currentScript.src).toString(),
      writable: false,
      configurable: false,
    });
  }
  Object.defineProperty(window, "WtsWeb", { value: api, writable: false, configurable: false });
}

export default api;

declare global {
  interface Window {
    WtsWeb: typeof api;
  }
}
