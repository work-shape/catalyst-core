import { z } from "zod";
import {
  JSON_SCHEMA_DATA_KEYWORDS,
  JSON_SCHEMA_MAP_KEYWORDS,
  isCheckFormat,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";

/**
 * The JSON Schema a model is shown for a Zod schema, as `defineTool` derives it. A tool whose
 * input schema is wider than a model needs passes one derived from a narrower schema as
 * `inputJsonSchema`; its own schema still checks every call.
 */
export function deriveInputJsonSchema(schema: z.ZodType<unknown>): JsonObject {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
    unrepresentable: "any"
  });
  return sanitizeJsonSchemaObject(jsonSchema);
}

/**
 * What a value of a derived schema is: a schema, a map of schemas by name (`properties` and the
 * like), or data (`default`, `enum`, `const`, `examples`), which is kept as it is written.
 */
type SchemaPart = "schema" | "map" | "data";

function sanitizeJsonSchemaValue(
  value: unknown,
  part: SchemaPart = "schema"
): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonSchemaValue(item, part))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (isRecord(value)) {
    return sanitizeJsonSchemaObject(value, part);
  }
  return undefined;
}

/**
 * Keywords of a derived schema that cost the model tokens on every call and tell it nothing it
 * needs, since the Zod schema still checks every call: a `pattern` beside a `format` (an
 * e-mail's long regex), the bounds of a safe integer, a minimum of one, a length no model
 * writes, and property names that are strings, as every JSON object's are. The name of a Zod
 * string check in `format` goes too, and its `pattern` stays because it states the check.
 */
function isModelNoise(key: string, value: unknown, parent: Record<string, unknown>): boolean {
  switch (key) {
    case "format":
      return isCheckFormat(value);
    case "pattern":
      return "format" in parent && !isCheckFormat(parent.format);
    case "maximum":
    case "minimum":
      return value === Number.MAX_SAFE_INTEGER || value === Number.MIN_SAFE_INTEGER;
    case "minLength":
    case "minItems":
      return value === 1;
    case "maxLength":
      return typeof value === "number" && value >= 1_000;
    case "propertyNames":
      return isRecord(value) && Object.keys(value).length === 1 && value.type === "string";
    default:
      return false;
  }
}

function sanitizeJsonSchemaObject(
  input: Record<string, unknown>,
  part: SchemaPart = "schema"
): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "$schema" || key === "~standard") {
      continue;
    }
    if (part === "schema" && isModelNoise(key, value, input)) {
      continue;
    }
    const childPart: SchemaPart =
      part === "data"
        ? "data"
        : part === "map"
          ? "schema"
          : JSON_SCHEMA_MAP_KEYWORDS.has(key)
            ? "map"
            : JSON_SCHEMA_DATA_KEYWORDS.has(key)
              ? "data"
              : "schema";
    const sanitizedValue = sanitizeJsonSchemaValue(value, childPart);
    if (sanitizedValue !== undefined) {
      output[key] = sanitizedValue;
    }
  }
  if (part === "schema" && isObjectJsonSchema(output) && !("additionalProperties" in output)) {
    output.additionalProperties = false;
  }
  return output;
}

function isObjectJsonSchema(schema: JsonObject): boolean {
  if (schema.type === "object") {
    return true;
  }
  return Array.isArray(schema.type) && schema.type.includes("object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
