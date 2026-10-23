import { createHash, createHmac, hkdfSync } from "node:crypto";
import { AppError, canonicalJson, unknownToJsonValue } from "@work-shape/catalyst-core";

/** Separate purpose and instance from other uses of the existing Secret Store key. */
export function derivePersonalInputHashKey(secret: string, clientInstanceId: string): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", secret, clientInstanceId, "catalyst personal operation input hash v1", 32)
  );
}

/** Personal calls fail closed when the instance has no key; never fall back to a public hash. */
export function requirePersonalInputHashKey(key: Uint8Array | undefined): Uint8Array {
  if (!key?.byteLength)
    throw new AppError("INTERNAL", "Personal operation input hash key is unavailable");
  return key;
}

/** Canonical input digest; personal calls supply the instance key for HMAC-SHA-256. */
export function hashInput(input: unknown, key?: Uint8Array): string {
  return (key ? createHmac("sha256", key) : createHash("sha256"))
    .update(canonicalJson(unknownToJsonValue(input)))
    .digest("hex");
}
