const STORAGE_PREFIX = "wts-test-session-v2-";

export function hasPersistedTestSession(sourceKey: string): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(testSessionStorageKey(sourceKey)) !== null;
  } catch {
    return false;
  }
}

export function testSessionStorageKey(sourceKey: string): string {
  return `${STORAGE_PREFIX}${sourceKey}`;
}

export function clearPersistedTestSession(sourceKey: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(testSessionStorageKey(sourceKey));
  } catch {
    // A restricted storage API is equivalent to an already cleared session.
  }
}
