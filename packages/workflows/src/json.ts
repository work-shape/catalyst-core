import {
  WORKFLOW_DATASET_KEY,
  workflowDatasetReferenceSchema,
  type JsonObject,
  type JsonValue
} from "@vivd-catalyst/core";
import { z } from "zod";

/** A value that is JSON, as the product's own type names it. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

/** How many bytes a value takes as JSON in UTF-8. */
export function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Whether a value holds the key that marks a dataset anywhere without being a reference to
 * one. Step data never carries that key for anything else.
 */
export function holdsBrokenDatasetReference(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(holdsBrokenDatasetReference);
  if (Object.hasOwn(value, WORKFLOW_DATASET_KEY)) {
    return !workflowDatasetReferenceSchema.safeParse(value).success;
  }
  return Object.values(value).some(holdsBrokenDatasetReference);
}
