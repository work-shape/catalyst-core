import {
  WORKFLOW_DATASET_KEY,
  WORKFLOW_DATASET_TYPE,
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

/** A NUL character or half of a surrogate pair: what the store cannot hold in a JSON value. */
function isStorableText(text: string): boolean {
  return !text.includes("\u0000") && !/\p{Surrogate}/u.test(text);
}

/** How many places `unstorableTextPaths` names before it stops. */
const UNSTORABLE_TEXT_PATHS_MAX = 20;

/**
 * The places in a value that the store cannot hold, as the segments of a JSON pointer: a text
 * with a NUL character or half of a surrogate pair, or an object with such a key, which is
 * named by the object so no path carries the text itself. Walked without recursion, since a
 * value is as deep as its sender made it.
 */
export function unstorableTextPaths(value: JsonValue): string[][] {
  const paths: string[][] = [];
  const open: { value: JsonValue; path: string[] }[] = [{ value, path: [] }];
  for (
    let next = open.pop();
    next && paths.length < UNSTORABLE_TEXT_PATHS_MAX;
    next = open.pop()
  ) {
    const { value: item, path } = next;
    if (typeof item === "string") {
      if (!isStorableText(item)) paths.push(path);
    } else if (Array.isArray(item)) {
      item.forEach((entry, index) => open.push({ value: entry, path: [...path, String(index)] }));
    } else if (item !== null && typeof item === "object") {
      const entries = Object.entries(item);
      if (entries.some(([key]) => !isStorableText(key))) {
        paths.push(path);
        continue;
      }
      for (const [key, entry] of entries) open.push({ value: entry, path: [...path, key] });
    }
  }
  return paths;
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

/** Whether a value holds a reference to a dataset anywhere. */
export function holdsDatasetReference(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(holdsDatasetReference);
  return (
    Object.hasOwn(value, WORKFLOW_DATASET_KEY) || Object.values(value).some(holdsDatasetReference)
  );
}

/** Whether a step schema names the type `dataset` for itself or for one of its fields. */
export function namesDatasetType(schema: JsonValue): boolean {
  if (schema === null || typeof schema !== "object") return false;
  if (Array.isArray(schema)) return schema.some(namesDatasetType);
  return schema.type === WORKFLOW_DATASET_TYPE || Object.values(schema).some(namesDatasetType);
}
