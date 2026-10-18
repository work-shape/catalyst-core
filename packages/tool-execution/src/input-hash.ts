import { createHash } from "node:crypto";
import { canonicalJson, unknownToJsonValue } from "@work-shape/catalyst-core";

/** The hash a run keeps in place of its input: SHA-256 over the input with sorted keys. */
export function hashInput(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(unknownToJsonValue(input)))
    .digest("hex");
}
