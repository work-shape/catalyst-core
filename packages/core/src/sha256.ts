import { createHash } from "node:crypto";

// A separate Node-only entry keeps core's root usable in browsers.
/** SHA-256 as lowercase hex; strings are UTF-8 and byte arrays are hashed without decoding. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
