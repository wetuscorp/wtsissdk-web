import { createUuid } from "./runtime";

const LEASE_MS = 10_000;

export class MultiTabLock {
  private current: Promise<unknown> | undefined;

  constructor(private readonly name: string) {}

  async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(this.name, operation);
    }
    if (this.current) await this.current;
    const lease = this.acquireLease();
    if (!lease) return undefined;
    const current = operation();
    this.current = current;
    try {
      return await current;
    } finally {
      if (this.current === current) this.current = undefined;
      lease.release();
    }
  }

  private acquireLease(): { release(): void } | undefined {
    if (typeof localStorage === "undefined") return { release() {} };
    const key = `wts-lock-${this.name}`;
    const token = createUuid();
    const now = Date.now();
    try {
      const current = parseLease(localStorage.getItem(key));
      if (current && current.expiresAt > now) return undefined;
      localStorage.setItem(key, JSON.stringify({ token, expiresAt: now + LEASE_MS }));
      const acquired = parseLease(localStorage.getItem(key));
      if (acquired?.token !== token) return undefined;
      return {
        release() {
          const latest = parseLease(localStorage.getItem(key));
          if (latest?.token === token) localStorage.removeItem(key);
        },
      };
    } catch {
      return { release() {} };
    }
  }
}

function parseLease(value: string | null): { token: string; expiresAt: number } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { token?: unknown; expiresAt?: unknown };
    return typeof parsed.token === "string" && typeof parsed.expiresAt === "number"
      ? { token: parsed.token, expiresAt: parsed.expiresAt }
      : undefined;
  } catch {
    return undefined;
  }
}
