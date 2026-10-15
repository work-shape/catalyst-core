import { isJsonObject, type JsonObject } from "@work-shape/catalyst-core";

/**
 * The answer format of a call as Claude on Bedrock takes it: `output_config.format` with a JSON
 * Schema, the Messages format's own structured output. The model's answer is then one text
 * block that holds JSON of that schema. No tool is forced for it, so tools and thinking stay
 * usable in the same call.
 *
 * Bedrock compiles the schema and refuses the request for a keyword it does not compile. The
 * product's schema says what the caller checks afterwards, so the keywords Bedrock refuses are
 * left out here and the caller's own check still holds them:
 * - an object always states `additionalProperties: false`, the one value Bedrock takes;
 * - bounds on numbers, on the length of a string and on the count of an object's properties
 *   are left out;
 * - of the bounds on a list, `minItems` of 0 or 1 stays.
 * A schema that refers to itself, or to another document, is not rewritten: Bedrock refuses it,
 * and the call fails as a refused request.
 */
export function toBedrockOutputFormat(schema: JsonObject): {
  type: "json_schema";
  schema: JsonObject;
} {
  return { type: "json_schema", schema: toBedrockSchema(schema) };
}

const REFUSED_KEYWORDS: ReadonlySet<string> = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties"
]);
/** Keywords whose value is one schema. */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(["items", "not"]);
/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  "anyOf",
  "allOf",
  "oneOf",
  "prefixItems"
]);
/** Keywords whose value names schemas: its keys are names, never keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set(["properties", "$defs", "definitions"]);

function toBedrockSchema(schema: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (REFUSED_KEYWORDS.has(keyword) || keyword === "additionalProperties") {
      continue;
    }
    if (keyword === "minItems") {
      if (value === 0 || value === 1) result[keyword] = value;
    } else if (SCHEMA_KEYWORDS.has(keyword) && isJsonObject(value)) {
      result[keyword] = toBedrockSchema(value);
    } else if (SCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
      result[keyword] = value.map((item) => (isJsonObject(item) ? toBedrockSchema(item) : item));
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && isJsonObject(value)) {
      result[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          isJsonObject(item) ? toBedrockSchema(item) : item
        ])
      );
    } else {
      result[keyword] = value;
    }
  }
  if (describesObject(schema)) {
    result.additionalProperties = false;
  }
  return result;
}

function describesObject(schema: JsonObject): boolean {
  const type = schema.type;
  return (
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    isJsonObject(schema.properties)
  );
}
