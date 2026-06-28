export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function unknownToJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(unknownToJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const result: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested !== "undefined" && typeof nested !== "function" && typeof nested !== "symbol") {
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
