import { createWtsClient } from "./index";

const api = { createWtsClient };

if (typeof window !== "undefined") {
  Object.defineProperty(window, "WtsWeb", { value: api, writable: false, configurable: false });
}

export default api;

declare global {
  interface Window {
    WtsWeb: typeof api;
  }
}
