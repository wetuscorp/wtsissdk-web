import { createPublicKey } from "node:crypto";

const encoded = process.env.WTS_EXPERIENCE_ROOT_PUBLIC_KEY?.trim();
if (!encoded) throw new Error("WTS_EXPERIENCE_ROOT_PUBLIC_KEY is required for release builds.");
const key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
if (key.asymmetricKeyType !== "ed25519") {
  throw new Error("WTS_EXPERIENCE_ROOT_PUBLIC_KEY must be an Ed25519 SPKI DER public key.");
}
console.log("Validated the embedded wts.is Experiences root public key.");
