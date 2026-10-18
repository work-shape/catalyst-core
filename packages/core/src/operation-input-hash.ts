import { createHash } from "node:crypto";
import { unknownToJsonValue, type JsonValue } from "./json";

/** The hash a run keeps in place of its input: SHA-256 over the input with sorted keys. */
export function hashInput(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(unknownToJsonValue(input)))
    .digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
