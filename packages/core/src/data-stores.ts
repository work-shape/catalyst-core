import { z } from "zod";
import type { AssetKindActions } from "./asset-kinds";
import type { JsonObject } from "./json";

// The names and shapes of a Data Store and of a Knowledge Base that more than one package
// reads: the asset kinds, what their operations and jobs are called, and the handle a caller
// reaches the rows of one store through. The store is in `@vivd-catalyst/data-stores`.

/** The asset kind of a Data Store. Spec: data-stores-and-knowledge-bases.md, build order DS-1. */
export const DATA_STORE_ASSET_KIND = "data_store";

/** The file of a Data Store's folder that holds its definition. Spec: One data store primitive. */
export const DATA_STORE_MANIFEST_FILE = "store.yaml";

/**
 * The asset kind of a Knowledge Base. A kind of its own, with rights of its own: a Data Store
 * is one of its backends, not what it is. Spec: build order WD-2.
 */
export const KNOWLEDGE_BASE_ASSET_KIND = "knowledge_base";

/** The file of a Knowledge Base's folder that holds its definition. Spec: Knowledge Base on top. */
export const KNOWLEDGE_BASE_MANIFEST_FILE = "kb.yaml";

/**
 * The rights of the kind. `write` changes the definition and its migrations. `insert` adds
 * rows and changes nothing of the definition: it is what the service principal of a Workflow
 * is granted, so a run that stores findings cannot edit a migration. `execute` is reserved for
 * changing statements other than an insert and is asked by nothing yet. The kind has no `use`: a
 * person reaches the rows through an App, whose `app.use` is checked. Spec: One data store
 * primitive, scope.
 */
export const DATA_STORE_ACTIONS = {
  read: "data_store.read",
  write: "data_store.write",
  publish: "data_store.publish",
  delete: "data_store.delete",
  insert: "data_store.insert",
  execute: "data_store.execute"
} as const satisfies AssetKindActions & { insert: string; execute: string };

/** The rights of the kind. `use` searches and queries the published revision. */
export const KNOWLEDGE_BASE_ACTIONS = {
  read: "knowledge_base.read",
  write: "knowledge_base.write",
  publish: "knowledge_base.publish",
  delete: "knowledge_base.delete",
  use: "knowledge_base.use"
} as const satisfies AssetKindActions;

/**
 * The prefix of every operation on the rows of one Data Store: `data_store.<id>.<verb>`. The
 * id holds no dot. It is singular. Operations that manage Data Stores have a two-part name in
 * the plural, such as `data_stores.publish`.
 */
export const DATA_STORE_OPERATION_PREFIX = "data_store.";

/**
 * What an operation of one Data Store does, and the right on that store it needs. `query` runs
 * read-only SQL and `insert` adds rows. `describe` answers the store's tables and columns
 * (`DataStoreSchema`) and `preview_rows` the first rows of one table, at most
 * `DATA_STORE_PREVIEW_ROW_LIMIT`: the two reads of the store's page.
 *
 * `insert` and `load` need `data_store.insert`, the right on rows, and not `data_store.write`.
 * A `load` that changes or removes rows, with `onConflict: "update"` or with `replace`, needs
 * `data_store.execute` as well (`DATA_STORE_LOAD_CHANGE_RIGHT`). A step of
 * a Workflow calls these as the run's principal, so that service principal is granted the
 * right on the store. No right is implied by the Workflow or by whoever published it.
 */
export const DATA_STORE_OPERATION_VERBS = [
  "query",
  "insert",
  "load",
  "describe",
  "preview_rows"
] as const;

export type DataStoreOperationVerb = (typeof DATA_STORE_OPERATION_VERBS)[number];

/** The right on the store each verb needs. */
export const DATA_STORE_OPERATION_RIGHTS = {
  query: DATA_STORE_ACTIONS.read,
  insert: DATA_STORE_ACTIONS.insert,
  load: DATA_STORE_ACTIONS.insert,
  describe: DATA_STORE_ACTIONS.read,
  preview_rows: DATA_STORE_ACTIONS.read
} as const satisfies Record<DataStoreOperationVerb, string>;

/**
 * What `insert` does with a row that a unique constraint of the table refuses. `fail` refuses
 * the whole call and adds no row. `skip` leaves such a row out and adds the others, against
 * every unique constraint of the table, the primary key among them.
 *
 * The idempotency key of a step protects one run: a retried step run answers with its first
 * result. It does not protect a second run. `skip` on a table with a unique constraint over
 * what makes a row the same row is what makes a rerun, and next month's run, safe.
 */
export const DATA_STORE_INSERT_CONFLICT_MODES = ["fail", "skip"] as const;

export type DataStoreInsertConflictMode = (typeof DATA_STORE_INSERT_CONFLICT_MODES)[number];

/** `onConflict` of an insert as its input schema reads it: `fail` when left out. */
export const dataStoreInsertConflictSchema = z
  .enum(DATA_STORE_INSERT_CONFLICT_MODES)
  .default("fail");

/** The input of `data_store.<id>.insert`. */
export interface DataStoreInsertInput {
  table: string;
  /** Every row names the same columns. */
  rows: readonly JsonObject[];
  /** `fail` when left out. */
  onConflict?: DataStoreInsertConflictMode;
}

/**
 * What `data_store.<id>.insert` answers. Both counts add up to the rows of the call. With
 * `fail` no row is ever skipped.
 */
export const dataStoreInsertResultSchema = z.object({
  table: z.string(),
  inserted: z.number().int().min(0),
  skipped: z.number().int().min(0)
});

export type DataStoreInsertResult = z.infer<typeof dataStoreInsertResultSchema>;

/**
 * What `load` does with a row whose `key` a row of the table has. `update` writes the row of
 * the dataset over it. `skip` and `update` need `key`.
 */
export const DATA_STORE_LOAD_CONFLICT_MODES = ["fail", "skip", "update"] as const;

export type DataStoreLoadConflictMode = (typeof DATA_STORE_LOAD_CONFLICT_MODES)[number];

/** The right a `load` needs beside `data_store.insert` where it changes or removes rows. */
export const DATA_STORE_LOAD_CHANGE_RIGHT = DATA_STORE_ACTIONS.execute;

/**
 * The input of `data_store.<id>.load`, which takes a dataset of a Workflow Run into one table
 * in one transaction, once per step run. Reserved: the slice that brings datasets runs it.
 * Spec: Loading a dataset.
 */
export const dataStoreLoadInputSchema = z
  .strictObject({
    table: z.string().min(1),
    /** The reference of the dataset as the step data holds it. */
    dataset: z.unknown(),
    /** Row field to column. By name where left out. */
    columns: z.record(z.string(), z.string()).optional(),
    /** The columns that tell two rows apart. */
    key: z.array(z.string().min(1)).min(1).optional(),
    onConflict: z.enum(DATA_STORE_LOAD_CONFLICT_MODES).default("fail"),
    /**
     * Replace by key: first deletes the rows whose values of these columns occur in the
     * dataset, then inserts the dataset. `by` names columns of `key`.
     */
    replace: z.strictObject({ by: z.array(z.string().min(1)).min(1) }).optional()
  })
  .refine((input) => input.onConflict === "fail" || input.key !== undefined, {
    message: "onConflict 'skip' and 'update' need 'key'",
    path: ["key"]
  })
  .refine(
    (input) =>
      input.replace === undefined ||
      input.replace.by.every((column) => input.key?.includes(column) === true),
    {
      message:
        "'replace' deletes the rows that carry the values of 'by' and inserts the dataset; it needs 'key', which makes the inserted rows unique, and 'by' names columns of 'key'",
      path: ["replace"]
    }
  );

export type DataStoreLoadInput = z.input<typeof dataStoreLoadInputSchema>;

/** What `data_store.<id>.load` answers: the four counts and no row. */
export const dataStoreLoadResultSchema = z.object({
  table: z.string(),
  inserted: z.number().int().min(0),
  updated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  deleted: z.number().int().min(0)
});

export type DataStoreLoadResult = z.infer<typeof dataStoreLoadResultSchema>;

/**
 * The schema the platform owns in the database of every store, for what it keeps there, such
 * as the migrations it applied and the loads it made. A migration that names it is refused.
 */
export const DATA_STORE_RESERVED_SCHEMA = "catalyst";

/** The most rows `preview_rows` answers. */
export const DATA_STORE_PREVIEW_ROW_LIMIT = 50;

/**
 * The types one value of a statement is declared with, and the types `describe` and a result
 * name a column by. They are the product's own, so a caller reads the same names whatever
 * backend a store has. A list of values of one type is the type followed by `[]`. Spec:
 * apps-and-pages.md, Named actions, `sql`.
 */
export const DATA_STORE_SCALAR_TYPES = [
  "text",
  "integer",
  "number",
  "boolean",
  "date",
  "timestamp"
] as const;

export type DataStoreScalarType = (typeof DATA_STORE_SCALAR_TYPES)[number];
export type DataStoreParameterType = DataStoreScalarType | `${DataStoreScalarType}[]`;

/** A column's type as the product names it. `other` is a type of the backend that has no name here. */
export type DataStoreColumnType = DataStoreParameterType | "other";

export interface DataStoreColumn {
  name: string;
  type: DataStoreColumnType;
  /** The type as the store's database names it, such as `numeric(12,2)`. For people to read. */
  nativeType: string;
  nullable: boolean;
  default?: string;
  primaryKey: boolean;
  comment?: string;
}

export interface DataStoreTable {
  name: string;
  comment?: string;
  columns: readonly DataStoreColumn[];
  /** The planner's estimate, not a count. */
  rowEstimate: number;
}

/** What `describe` answers: the tables of one store at its migration level. */
export interface DataStoreSchema {
  schemaLevel: number;
  tables: readonly DataStoreTable[];
}

/** The operation name of one verb on one Data Store. */
export function dataStoreOperationName(store: string, verb: DataStoreOperationVerb): string {
  return `${DATA_STORE_OPERATION_PREFIX}${store}.${verb}`;
}

/**
 * The prefix of every operation of one Knowledge Base: `knowledge.<id>.search` and
 * `knowledge.<id>.query`. Rights, policy and audit are per Knowledge Base. Spec: P40.
 */
export const KNOWLEDGE_OPERATION_PREFIX = "knowledge.";

/** The operation that answers read-only SQL on one structured Knowledge Base. Spec: P38. */
export function knowledgeQueryOperationName(knowledgeBase: string): string {
  return `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase}.query`;
}

/**
 * The one tool an agent queries its structured Knowledge Bases with. It names no Knowledge
 * Base: it is a projection that calls the operation of the one its input names. Spec: P40, P116.
 */
export const KNOWLEDGE_QUERY_TOOL_NAME = "knowledge.query";

/**
 * The job kinds of the store. `provision` creates the database and the roles of a new store,
 * `migrate` applies the pending migrations of a publish, `measure_size` records the size of
 * every store once a day. Spec: One data store primitive.
 */
export const DATA_STORE_JOB_KINDS = {
  provision: "data_store.provision",
  migrate: "data_store.migrate",
  measureSize: "data_store.measure_size"
} as const;

export type DataStoreJobKind = (typeof DATA_STORE_JOB_KINDS)[keyof typeof DATA_STORE_JOB_KINDS];

/**
 * What the platform keeps of each Data Store, as `PlatformStores.dataStores`: where it lives and
 * the level it is at. It is bound to a transaction like every store of the platform. The first
 * slice of the store gives it its methods.
 */
export interface DataStoreRecordsStore {}

/** A Data Store as a manifest names it. Spec: apps-and-pages.md, Manifest, `dataStores`. */
export interface DataStoreReference {
  /** The id of the store. */
  name: string;
  /** The migration level the caller needs. A store below it is refused. */
  minSchema?: number;
}

type DataStoreValue =
  string | number | boolean | null | readonly (string | number | boolean | null)[];

/**
 * One value a statement binds. It never becomes part of the statement's text. A bare value
 * leaves its type to the database; a value with a declared type is bound as that type.
 */
export type DataStoreParameter =
  DataStoreValue | { type: DataStoreParameterType; value: DataStoreValue };

/** SQL with positional placeholders and the values they are bound to. */
export interface DataStoreStatement {
  sql: string;
  parameters?: readonly DataStoreParameter[];
}

export interface DataStoreRows {
  /** The columns in the order of the statement, present even when no row is. */
  columns: readonly { name: string; type: DataStoreColumnType; nativeType: string }[];
  rows: readonly JsonObject[];
  /** Whether the row cap or the byte cap ended the result before its last row. */
  truncated: boolean;
}

/**
 * The rows of one Data Store, as a step of a Workflow and a named action of an App reach them.
 * Every call runs as the store's app role, which holds no right to change the schema, under
 * that role's statement timeout. The caller's right was checked before it was handed this.
 * Spec: One data store primitive; How apps, agents, workflows and humans reach data.
 */
export interface DataStoreHandle {
  readonly store: string;
  /** The migration level the store is at. */
  readonly schemaLevel: number;
  /** Runs one statement in a read-only transaction under the row cap. */
  query(statement: DataStoreStatement, options?: DataStoreCallOptions): Promise<DataStoreRows>;
  /** Runs one changing statement in one transaction and answers how many rows it touched. */
  execute(
    statement: DataStoreStatement,
    options?: DataStoreCallOptions
  ): Promise<{ rowCount: number }>;
}

export interface DataStoreCallOptions {
  /** Aborting it cancels the statement on the server. */
  signal?: AbortSignal;
}
