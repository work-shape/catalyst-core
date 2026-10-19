import { compileJsonSchema } from "@work-shape/catalyst-connections";
import { isJsonObject, type JsonObject, type JsonValue } from "@work-shape/catalyst-core";

/** All bindings support these JSON shapes; references, expressions and datasets are excluded. */
export function agentOutputSchemaSupported(schema: JsonObject): boolean {
  const visit = (value: JsonValue): boolean => {
    if (!isJsonObject(value)) return false;
    const allowed = [
      "type",
      "properties",
      "required",
      "items",
      "enum",
      "additionalProperties",
      "description",
      "title",
      "$schema"
    ];
    if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
    if (!["object", "array", "string", "number", "integer", "boolean"].includes(String(value.type)))
      return false;
    if (
      value.properties !== undefined &&
      (!isJsonObject(value.properties) ||
        !Object.values(value.properties).every((field) => field !== undefined && visit(field)))
    )
      return false;
    if (value.items !== undefined && !visit(value.items)) return false;
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean")
      return false;
    return true;
  };
  return visit(schema) && compileJsonSchema(schema).ok;
}
