export function installSpaTracker(onNavigate: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const historyApi = window.history;
  const originalPush = historyApi.pushState;
  const originalReplace = historyApi.replaceState;
  let scheduled = false;
  const notify = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      onNavigate();
    });
  };
  historyApi.pushState = function (...args) {
    originalPush.apply(this, args);
    notify();
  };
  historyApi.replaceState = function (...args) {
    originalReplace.apply(this, args);
    notify();
  };
  window.addEventListener("popstate", notify);
  return () => {
    historyApi.pushState = originalPush;
    historyApi.replaceState = originalReplace;
    window.removeEventListener("popstate", notify);
  };
}
