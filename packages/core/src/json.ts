import { isRecord } from "@work-shape/catalyst-asset-schemas";

export { isRecord } from "@work-shape/catalyst-asset-schemas";

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

export function unknownToJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(unknownToJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const result: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (
        typeof nested !== "undefined" &&
        typeof nested !== "function" &&
        typeof nested !== "symbol"
      ) {
        result[key] = unknownToJsonValue(nested);
      }
    }
    return result;
  }
  if (typeof value === "undefined") {
    return null;
  }
  return String(value);
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, withSortedKeys(entry)])
  );
}

/**
 * Whether two values are the same JSON. Object key order carries no meaning: a JSON column may
 * return keys in another order than they were written in.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(withSortedKeys(left)) === JSON.stringify(withSortedKeys(right));
}

/** Stable JSON for operation hashes. Numeric-looking keys also stay in lexical order,
 * preserving the stored hash format; JSON.stringify would reorder those keys numerically. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
