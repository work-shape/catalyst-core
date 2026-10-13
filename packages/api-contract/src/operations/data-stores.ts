import { z } from "zod";
import { defineRegisteredOperation, json } from "./define-operation";

// The routes to one Data Store: four verbs on its rows and the read of its state, each with
// the store's id in its path. A route is no operation of its own. Its call runs as the store's
// operation `data_store.<id>.<verb>`, the one a Workflow step and an agent call, with that
// operation's right (`data_store.read`, and `data_store.insert` to add rows), policy, run and
// audit trail.

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

const DATA_STORE_CONDITIONS = [
  "server_databases_open",
  "sessions_open",
  "temp_files_unbounded"
] as const;

const dataStoreStateResponseSchema = z.object({
  /** The id of the store's asset. */
  id: z.string(),
  /** The id operations and routes name the store by. */
  name: z.string(),
  /** `provisioning` until the database of the store is complete. */
  status: z.enum(["provisioning", "ready"]),
  /** The number of the last migration the database has applied. */
  level: z.number().int(),
  /** The number of the last migration of the published revision. */
  publishedLevel: z.number().int(),
  size: z.object({
    /** What the last measurement found. Missing before the first. */
    bytes: z.number().int().optional(),
    measuredAt: z.string().optional(),
    limitBytes: z.number().int(),
    /** Whether the store is at 80 percent of its limit or above. */
    nearLimit: z.boolean()
  }),
  /** What the server leaves open around the store, each with what an operator does about it. */
  conditions: z.array(z.object({ code: z.enum(DATA_STORE_CONDITIONS), message: z.string() })),
  /** How the last attempt to bring the store to its published revision ended. */
  lastMigration: z.object({
    outcome: z.enum(["none", "pending", "applied", "failed"]),
    migration: z.object({ number: z.number().int(), name: z.string() }).optional(),
    failure: z.object({ code: z.string(), message: z.string() }).optional()
  })
});

const READ = {
  tag: "Data Stores",
  auth: "principal",
  scope: "data_store_rows:read",
  requires: [],
  effect: "reading",
  errors: ["NOT_FOUND", "CONFLICT", "TIMEOUT"],
  rateClass: "read"
} as const;

// None names its right in `requires`: the right is the store operation's. The scopes are the
// ones the contract names per verb (`DATA_STORE_OPERATION_SCOPES`); `describe` reads the
// definition of a store and stays under `config_assets:read`.
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
    scope: "data_store_rows:write",
    requires: [],
    effect: "changing",
    body: dataStoreInsertRequestSchema,
    response: json(dataStoreInsertResponseSchema),
    errors: ["NOT_FOUND", "CONFLICT", "TIMEOUT"],
    rateClass: "write"
  }),
  "data_stores.describe": defineRegisteredOperation({
    ...READ,
    scope: "config_assets:read",
    id: "data_stores.describe",
    method: "GET",
    path: "/api/v1/data-stores/:store/describe",
    summary: "Read the tables and columns of one Data Store at its migration level",
    response: json(dataStoreSchemaResponseSchema)
  }),
  "data_stores.get": defineRegisteredOperation({
    ...READ,
    scope: "config_assets:read",
    id: "data_stores.get",
    method: "GET",
    path: "/api/v1/data-stores/:store",
    summary:
      "Read the state of one Data Store: its migration level, its size against its limit, what the server leaves open and how its last migration ended",
    response: json(dataStoreStateResponseSchema),
    errors: ["NOT_FOUND"]
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
