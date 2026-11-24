import { isJsonObject, type JsonObject, type JsonValue } from "./json";

/** JSON Schema keywords whose value names schemas: its keys are names, never keywords. */
export const JSON_SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions"
]);
/** JSON Schema keywords whose value is data, kept as it is written. */
export const JSON_SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "enum",
  "const",
  "examples"
]);

const CHECK_FORMATS: ReadonlySet<unknown> = new Set([
  "starts_with",
  "ends_with",
  "includes",
  "lowercase",
  "uppercase"
]);

/**
 * Zod writes the name of a string check into `format`, next to the `pattern` that states the
 * check. These names are no JSON Schema formats, and a provider that compiles the schema can
 * refuse the request for them.
 */
export function isCheckFormat(format: unknown): boolean {
  return CHECK_FORMATS.has(format);
}

function withoutInValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutInValue);
  return isJsonObject(value) ? withoutCheckFormats(value) : value;
}

/** The schema without check names in `format`. The patterns stay. */
export function withoutCheckFormats(schema: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword === "format" && isCheckFormat(value)) continue;
    if (JSON_SCHEMA_DATA_KEYWORDS.has(keyword)) {
      result[keyword] = value;
    } else if (JSON_SCHEMA_MAP_KEYWORDS.has(keyword) && isJsonObject(value)) {
      result[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, withoutInValue(item)])
      );
    } else {
      result[keyword] = withoutInValue(value);
    }
  }
  return result;
}
