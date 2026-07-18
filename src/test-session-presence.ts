const STORAGE_PREFIX = "wts-test-session-v1-";

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
