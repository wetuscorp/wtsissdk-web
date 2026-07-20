import type { ExperienceManifest, OnlineKeyset } from "./types";

declare const __WTS_EXPERIENCE_ROOT_PUBLIC_KEY__: string;

/**
 * Trust chain: embedded wts.is root -> online keyset -> source-bound manifest.
 * The online leaf may rotate without an application deploy.
 */
export async function verifyExperienceManifestPayload(input: {
  signedPayload: string;
  kid: string;
  signature: string;
  onlineKeyset: OnlineKeyset;
  expectedSourceKey: string;
  /** Test-only override; production callers always use the embedded root. */
  rootPublicKey?: string;
  now?: number;
}): Promise<ExperienceManifest> {
  const now = input.now ?? Date.now();
  const rootPublicKey = input.rootPublicKey ?? embeddedRootPublicKey();
  if (!rootPublicKey) throw experienceError("EXPERIENCE_ROOT_KEY_UNAVAILABLE");

  const keysetBytes = decodeBase64(input.onlineKeyset.signedPayload);
  await verifyEd25519(
    rootPublicKey,
    keysetBytes,
    decodeBase64(input.onlineKeyset.rootSignature),
    "EXPERIENCE_KEYSET_SIGNATURE_INVALID",
  );
  const trustedKeyset = parseOnlineKeyset(keysetBytes, now);
  if (!sameKeysetEnvelope(trustedKeyset, input.onlineKeyset)) {
    throw experienceError("EXPERIENCE_KEYSET_PAYLOAD_MISMATCH");
  }
  const leaf = trustedKeyset.keys.find(
    (key) =>
      key.keyId === input.kid &&
      Date.parse(key.notBefore) <= now &&
      Date.parse(key.expiresAt) > now,
  );
  if (!leaf) throw experienceError("EXPERIENCE_MANIFEST_KEY_UNTRUSTED");

  const manifestBytes = decodeBase64(input.signedPayload);
  await verifyEd25519(
    leaf.publicKey,
    manifestBytes,
    decodeBase64(input.signature),
    "EXPERIENCE_MANIFEST_SIGNATURE_INVALID",
  );
  const manifest = parseExperienceManifest(manifestBytes);
  if (manifest.sourceKey !== input.expectedSourceKey) {
    throw experienceError("EXPERIENCE_MANIFEST_SOURCE_MISMATCH");
  }
  const issuedAt = Date.parse(manifest.issuedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    issuedAt > now ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    throw experienceError("EXPERIENCE_MANIFEST_EXPIRED");
  }
  return manifest;
}

function embeddedRootPublicKey(): string {
  return typeof __WTS_EXPERIENCE_ROOT_PUBLIC_KEY__ === "string"
    ? __WTS_EXPERIENCE_ROOT_PUBLIC_KEY__
    : "";
}

async function verifyEd25519(
  encodedPublicKey: string,
  payload: Uint8Array,
  signature: Uint8Array,
  failureCode: string,
): Promise<void> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw experienceError("EXPERIENCE_SIGNATURE_UNSUPPORTED");
  let publicKey: CryptoKey;
  try {
    publicKey = await subtle.importKey(
      "spki",
      toArrayBuffer(decodeBase64(encodedPublicKey)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (error) {
    if (isUnsupportedAlgorithm(error)) throw experienceError("EXPERIENCE_SIGNATURE_UNSUPPORTED");
    throw experienceError("EXPERIENCE_KEY_INVALID");
  }
  try {
    const valid = await subtle.verify(
      { name: "Ed25519" },
      publicKey,
      toArrayBuffer(signature),
      toArrayBuffer(payload),
    );
    if (!valid) throw experienceError(failureCode);
  } catch (error) {
    if (error instanceof Error && error.message === failureCode) throw error;
    if (isUnsupportedAlgorithm(error)) throw experienceError("EXPERIENCE_SIGNATURE_UNSUPPORTED");
    throw experienceError(failureCode);
  }
}

function parseOnlineKeyset(
  bytes: Uint8Array,
  now: number,
): {
  version: number;
  issuedAt: string;
  expiresAt: string;
  keys: OnlineKeyset["keys"];
} {
  const parsed = parseCanonicalJson(bytes) as Partial<OnlineKeyset>;
  if (
    !Number.isInteger(parsed.version) ||
    typeof parsed.issuedAt !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    !Array.isArray(parsed.keys) ||
    parsed.keys.length < 1 ||
    parsed.keys.length > 8 ||
    Date.parse(parsed.issuedAt) > now ||
    Date.parse(parsed.expiresAt) <= now
  ) {
    throw experienceError("EXPERIENCE_KEYSET_INVALID");
  }
  const ids = new Set<string>();
  for (const key of parsed.keys) {
    if (
      !key ||
      typeof key.keyId !== "string" ||
      !key.keyId ||
      ids.has(key.keyId) ||
      key.algorithm !== "Ed25519" ||
      typeof key.publicKey !== "string" ||
      typeof key.notBefore !== "string" ||
      typeof key.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(key.notBefore)) ||
      !Number.isFinite(Date.parse(key.expiresAt))
    ) {
      throw experienceError("EXPERIENCE_KEYSET_INVALID");
    }
    ids.add(key.keyId);
  }
  return parsed as ReturnType<typeof parseOnlineKeyset>;
}

function parseExperienceManifest(bytes: Uint8Array): ExperienceManifest {
  const parsed = parseCanonicalJson(bytes) as Partial<ExperienceManifest>;
  if (
    parsed.schemaVersion !== 2 ||
    typeof parsed.sourceId !== "string" ||
    !parsed.sourceId ||
    typeof parsed.sourceKey !== "string" ||
    !parsed.sourceKey ||
    !Number.isInteger(parsed.manifestVersion) ||
    typeof parsed.generatedAt !== "string" ||
    typeof parsed.issuedAt !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    !Array.isArray(parsed.campaigns)
  ) {
    throw experienceError("EXPERIENCE_MANIFEST_INVALID");
  }
  return parsed as ExperienceManifest;
}

function parseCanonicalJson(bytes: Uint8Array): unknown {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw experienceError("EXPERIENCE_PAYLOAD_INVALID");
  }
  if (canonicalJson(parsed) !== text) throw experienceError("EXPERIENCE_PAYLOAD_NOT_CANONICAL");
  return parsed;
}

function sameKeysetEnvelope(
  trusted: ReturnType<typeof parseOnlineKeyset>,
  envelope: OnlineKeyset,
): boolean {
  return (
    canonicalJson(trusted) ===
    canonicalJson({
      version: envelope.version,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      keys: envelope.keys,
    })
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw experienceError("EXPERIENCE_BASE64_INVALID");
  }
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (!globalThis.atob) throw experienceError("EXPERIENCE_BASE64_UNSUPPORTED");
  const decoded = globalThis.atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isUnsupportedAlgorithm(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "NotSupportedError",
  );
}

function experienceError(code: string): Error {
  return new Error(code);
}
