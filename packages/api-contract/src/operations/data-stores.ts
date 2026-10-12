import { z } from "zod";
import { defineRegisteredOperation, json } from "./define-operation";

// The rows of one Data Store over HTTP: the four verbs of a store, each with the store's id
// in its path. They run as the store's app role and need the caller's right on that store
// (`data_store.read`, and `data_store.insert` to add rows), which is decided on the store the
// call names. A Workflow step and an agent reach the same verbs as `data_store.<id>.<verb>`.

/** How many rows one insert adds at most. */
const DATA_STORE_INSERT_MAX_ROWS = 1_000;
/** The most rows a preview answers. */
const DATA_STORE_PREVIEW_MAX_ROWS = 50;

const SCALAR_TYPES = ["text", "integer", "number", "boolean", "date", "timestamp"] as const;
const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const valueSchema = z.union([scalarSchema, z.array(scalarSchema)]);
const columnTypeSchema = z.string();
const tableNameSchema = z.string().min(1).max(63);
/** One row: column name to value. A value is whatever JSON the column holds. */
const rowSchema = z.record(z.string(), z.unknown());

const dataStoreQueryRequestSchema = z.strictObject({
  /** One read-only SELECT or WITH statement with positional placeholders. */
  sql: z.string().min(1),
  /** A bare value, or a value with the type it is bound as. Never part of the statement. */
  parameters: z
    .array(
      z.union([
        valueSchema,
        z.strictObject({
          type: z.enum(SCALAR_TYPES.flatMap((type) => [type, `${type}[]`] as const)),
          value: valueSchema
        })
      ])
    )
    .optional()
});

const dataStoreRowsSchema = z.object({
  /** `type` is the product's name of the type, `nativeType` the database's. */
  columns: z.array(z.object({ name: z.string(), type: columnTypeSchema, nativeType: z.string() })),
  rows: z.array(rowSchema),
  /** Whether a cap ended the result before its last row. */
  truncated: z.boolean()
});

const dataStoreInsertRequestSchema = z.strictObject({
  table: tableNameSchema,
  /** Every row names the same columns. */
  rows: z.array(rowSchema).min(1).max(DATA_STORE_INSERT_MAX_ROWS),
  /** What happens to a row a unique constraint refuses. `fail` when left out. */
  onConflict: z.enum(["fail", "skip"]).optional()
});

const dataStoreInsertResponseSchema = z.object({
  table: z.string(),
  inserted: z.number().int().min(0),
  skipped: z.number().int().min(0)
});

const dataStoreSchemaResponseSchema = z.object({
  /** The migration level the store is at. */
  schemaLevel: z.number().int(),
  tables: z.array(
    z.object({
      name: z.string(),
      comment: z.string().optional(),
      /** The planner's estimate, not a count. */
      rowEstimate: z.number(),
      columns: z.array(
        z.object({
          name: z.string(),
          type: columnTypeSchema,
          nativeType: z.string(),
          nullable: z.boolean(),
          default: z.string().optional(),
          primaryKey: z.boolean(),
          comment: z.string().optional()
        })
      )
    })
  )
});

const dataStorePreviewQuerySchema = z.object({
  table: tableNameSchema,
  limit: z.coerce.number().int().min(1).max(DATA_STORE_PREVIEW_MAX_ROWS).optional()
});

const READ = {
  tag: "Data Stores",
  auth: "principal",
  scope: "config_assets:read",
  requires: [],
  effect: "reading",
  errors: ["NOT_FOUND", "CONFLICT", "TIMEOUT"],
  rateClass: "read"
} as const;

// None names its right in `requires`: the right is the store's own and is decided on the
// store the call names, where a grant on the asset or on its workspace can answer it.
export const dataStoreOperations = {
  "data_stores.query": defineRegisteredOperation({
    ...READ,
    id: "data_stores.query",
    method: "POST",
    path: "/api/v1/data-stores/:store/query",
    summary: "Read rows of one Data Store with one read-only statement and bound parameters",
    body: dataStoreQueryRequestSchema,
    response: json(dataStoreRowsSchema)
  }),
  "data_stores.insert": defineRegisteredOperation({
    id: "data_stores.insert",
    method: "POST",
    path: "/api/v1/data-stores/:store/insert",
    summary: "Add rows to one table of one Data Store",
    tag: "Data Stores",
    auth: "principal",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: dataStoreInsertRequestSchema,
    response: json(dataStoreInsertResponseSchema),
    errors: ["NOT_FOUND", "CONFLICT", "TIMEOUT"],
    rateClass: "write"
  }),
  "data_stores.describe": defineRegisteredOperation({
    ...READ,
    id: "data_stores.describe",
    method: "GET",
    path: "/api/v1/data-stores/:store/describe",
    summary: "Read the tables and columns of one Data Store at its migration level",
    response: json(dataStoreSchemaResponseSchema)
  }),
  "data_stores.preview_rows": defineRegisteredOperation({
    ...READ,
    id: "data_stores.preview_rows",
    method: "GET",
    path: "/api/v1/data-stores/:store/preview-rows",
    summary: "Read the first rows of one table of one Data Store",
    query: dataStorePreviewQuerySchema,
    response: json(dataStoreRowsSchema)
  })
} as const;
