import { compileJsonSchema } from "@work-shape/catalyst-connections";
import { isJsonObject, type JsonObject, type JsonValue } from "@work-shape/catalyst-core";

/** The keys an agent output schema may hold at any level. */
const AGENT_OUTPUT_SCHEMA_KEYS = [
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
const AGENT_OUTPUT_SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean"];

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/**
 * What an agent output schema holds that no binding supports, as a sentence that names the
 * place and the fix, or nothing where every binding supports it. All bindings support these
 * JSON shapes; references, expressions and datasets are excluded.
 */
export function agentOutputSchemaProblem(schema: JsonObject): string | undefined {
  const visit = (value: JsonValue | undefined, at: string): string | undefined => {
    if (!isJsonObject(value)) return `'${at}' is no object: each level of the schema is one.`;
    const unknown = Object.keys(value).filter((key) => !AGENT_OUTPUT_SCHEMA_KEYS.includes(key));
    if (unknown.length > 0) {
      return `'${at}' has ${quoted(unknown)}, which an agent output schema does not support. It supports ${quoted(AGENT_OUTPUT_SCHEMA_KEYS)}.`;
    }
    if (!AGENT_OUTPUT_SCHEMA_TYPES.includes(String(value.type))) {
      return `'${at}.type' is ${value.type === undefined ? "missing" : JSON.stringify(value.type)}: each level names one type of ${quoted(AGENT_OUTPUT_SCHEMA_TYPES)}.`;
    }
    if (value.properties !== undefined) {
      if (!isJsonObject(value.properties)) {
        return `'${at}.properties' is no object of named fields.`;
      }
      for (const [name, field] of Object.entries(value.properties)) {
        const problem = visit(field, `${at}.properties.${name}`);
        if (problem !== undefined) return problem;
      }
    }
    if (value.items !== undefined) {
      const problem = visit(value.items, `${at}.items`);
      if (problem !== undefined) return problem;
    }
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean")
      return `'${at}.additionalProperties' is true or false, never a schema.`;
    return undefined;
  };
  return (
    visit(schema, "outputSchema") ??
    (compileJsonSchema(schema).ok
      ? undefined
      : "The schema is no valid JSON Schema: check 'required', 'enum' and the types of the values.")
  );
}
