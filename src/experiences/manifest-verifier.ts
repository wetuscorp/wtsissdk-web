import type { ExperienceManifest } from "./types";

/**
 * Verifies the exact canonical payload signed by the collector's
 * ExperienceManifestService. A key is deliberately supplied by the host app;
 * accepting a verification key from the bootstrap response would not provide
 * an authenticity boundary.
 */
export async function verifyExperienceManifestPayload(input: {
  signedPayload: string;
  kid: string;
  signature: string;
  manifestVerificationKeys: Readonly<Record<string, string>>;
}): Promise<ExperienceManifest> {
  const encodedPublicKey = input.manifestVerificationKeys[input.kid];
  if (!encodedPublicKey) throw experienceError("EXPERIENCE_MANIFEST_KEY_UNTRUSTED");

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw experienceError("EXPERIENCE_MANIFEST_SIGNATURE_UNSUPPORTED");

  let payloadBytes: Uint8Array;
  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    payloadBytes = decodeBase64(input.signedPayload);
  } catch {
    throw experienceError("EXPERIENCE_MANIFEST_PAYLOAD_INVALID");
  }
  try {
    publicKeyBytes = decodeBase64(encodedPublicKey);
  } catch {
    throw experienceError("EXPERIENCE_MANIFEST_KEY_INVALID");
  }
  try {
    signatureBytes = decodeBase64(input.signature);
  } catch {
    throw experienceError("EXPERIENCE_MANIFEST_SIGNATURE_INVALID");
  }

  let publicKey: CryptoKey;
  try {
    publicKey = await subtle.importKey(
      "spki",
      toArrayBuffer(publicKeyBytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (error) {
    if (isUnsupportedAlgorithm(error)) {
      throw experienceError("EXPERIENCE_MANIFEST_SIGNATURE_UNSUPPORTED");
    }
    throw experienceError("EXPERIENCE_MANIFEST_KEY_INVALID");
  }

  try {
    const valid = await subtle.verify(
      { name: "Ed25519" },
      publicKey,
      toArrayBuffer(signatureBytes),
      toArrayBuffer(payloadBytes),
    );
    if (!valid) throw experienceError("EXPERIENCE_MANIFEST_SIGNATURE_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "EXPERIENCE_MANIFEST_SIGNATURE_INVALID") {
      throw error;
    }
    if (isUnsupportedAlgorithm(error)) {
      throw experienceError("EXPERIENCE_MANIFEST_SIGNATURE_UNSUPPORTED");
    }
    throw experienceError("EXPERIENCE_MANIFEST_SIGNATURE_INVALID");
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
    ) as unknown;
    return parseExperienceManifest(parsed);
  } catch (error) {
    if (error instanceof Error && error.message === "EXPERIENCE_MANIFEST_INVALID") throw error;
    throw experienceError("EXPERIENCE_MANIFEST_PAYLOAD_INVALID");
  }
}

function parseExperienceManifest(value: unknown): ExperienceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw experienceError("EXPERIENCE_MANIFEST_INVALID");
  }
  const manifest = value as Partial<ExperienceManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.sourceId !== "string" ||
    !manifest.sourceId ||
    !Number.isInteger(manifest.sourceManifestVersion) ||
    typeof manifest.generatedAt !== "string" ||
    typeof manifest.expiresAt !== "string" ||
    !Array.isArray(manifest.campaigns)
  ) {
    throw experienceError("EXPERIENCE_MANIFEST_INVALID");
  }
  return manifest as ExperienceManifest;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error("INVALID_BASE64");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decode = globalThis.atob;
  if (!decode) throw new Error("BASE64_UNSUPPORTED");
  const decoded = decode(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isUnsupportedAlgorithm(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "NotSupportedError"
  );
}

function experienceError(code: string): Error {
  return new Error(code);
}
