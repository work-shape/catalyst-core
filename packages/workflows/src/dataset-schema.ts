import { compileJsonSchema } from "@work-shape/catalyst-connections";
import {
  AppError,
  workflowDatasetReferenceSchema,
  type JsonObject,
  type JsonValue,
  type WorkflowManifest,
  type WorkflowDatasetReference
} from "@work-shape/catalyst-core";
import { jsonObjectSchema } from "./json";

export function rowSchemaOf(schema: JsonObject, types: WorkflowManifest["types"]): JsonObject {
  if (typeof schema.$ref !== "string") return schema;
  const name = schema.$ref.startsWith("#/types/") ? schema.$ref.slice(8) : "";
  const row = types?.[name];
  if (!row || row.$ref !== undefined)
    throw new AppError("VALIDATION_FAILED", "The dataset row names no declared type", {
      reason: "dataset_schema_invalid"
    });
  return row;
}

/** Compile the platform keyword to the reference shape before asking the one JSON validator. */
export function workflowValueSchema(
  schema: JsonObject,
  types?: WorkflowManifest["types"]
): JsonObject {
  function walk(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    if (value.type === "dataset") {
      const row = rowSchemaOf(jsonObjectSchema.parse(value.row), types);
      if (!compileJsonSchema(row).ok)
        throw new AppError("VALIDATION_FAILED", "The dataset row schema cannot be checked", {
          reason: "dataset_schema_invalid"
        });
      return {
        type: "object",
        properties: {
          $dataset: { type: "string", minLength: 1 },
          rowCount: { type: "integer", minimum: 0 },
          bytes: { type: "integer", minimum: 0 },
          offset: { type: "integer", minimum: 0 }
        },
        required: ["$dataset", "rowCount", "bytes"],
        additionalProperties: false
      };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
  }
  return jsonObjectSchema.parse(walk(schema));
}

export function schemaAt(schema: JsonObject, path: string): JsonObject | undefined {
  let current: JsonObject | undefined = schema;
  for (const part of path.split(".").filter(Boolean)) {
    const properties: JsonObject | undefined = jsonObjectSchema.safeParse(current?.properties).data;
    current = jsonObjectSchema.safeParse(properties?.[part]).data;
    if (!current) return undefined;
  }
  return current;
}

/** Required fields must exist and be guaranteed, recursively. Extra producer fields fit. */
export function schemaFits(source: JsonObject, target: JsonObject): boolean {
  const typesOf = (value: JsonValue | undefined): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((type): type is string => typeof type === "string")
        : [];
  const fromTypes = typesOf(source.type),
    toTypes = typesOf(target.type);
  if (
    target.type !== undefined &&
    (!fromTypes.length ||
      !fromTypes.every(
        (type) => toTypes.includes(type) || (type === "integer" && toTypes.includes("number"))
      ))
  )
    return false;
  if (
    fromTypes.includes("array") &&
    !schemaFits(
      jsonObjectSchema.parse(source.items ?? {}),
      jsonObjectSchema.parse(target.items ?? {})
    )
  )
    return false;
  const required =
    (!fromTypes.length || fromTypes.includes("object")) && Array.isArray(target.required)
      ? target.required.filter((key): key is string => typeof key === "string")
      : [];
  const fromRequired = Array.isArray(source.required) ? source.required : [];
  const sourceProperties = jsonObjectSchema.safeParse(source.properties).data ?? {};
  const targetProperties = jsonObjectSchema.safeParse(target.properties).data ?? {};
  for (const key of required) {
    const from = Object.hasOwn(sourceProperties, key)
      ? jsonObjectSchema.safeParse(sourceProperties[key]).data
      : undefined;
    const to = Object.hasOwn(targetProperties, key)
      ? jsonObjectSchema.safeParse(targetProperties[key]).data
      : undefined;
    if (!from || !to || !fromRequired.includes(key) || !schemaFits(from, to)) return false;
  }
  return true;
}

export function datasetReferences(value: JsonValue): WorkflowDatasetReference[] {
  if (!value || typeof value !== "object") return [];
  if (
    !Array.isArray(value) &&
    typeof value.$dataset === "string" &&
    typeof value.rowCount === "number" &&
    typeof value.bytes === "number"
  ) {
    const reference = workflowDatasetReferenceSchema.safeParse(value);
    if (!reference.success)
      throw new AppError("VALIDATION_FAILED", "The dataset reference is malformed", {
        reason: "dataset_reference_invalid"
      });
    return [reference.data];
  }
  return Object.values(value).flatMap(datasetReferences);
}
