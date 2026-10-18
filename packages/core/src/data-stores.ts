import {
  DATA_STORE_INSERT_CONFLICT_MODES,
  DATA_STORE_LOAD_CONFLICT_MODES,
  DATA_STORE_SCALAR_TYPES
} from "@work-shape/catalyst-asset-schemas";
import { z } from "zod";
import type { AssetKindActions, AssetScope } from "./asset-kinds";
import type { DataStoreRecord } from "./data-store-records";
import { AppError, isAppError, type AppErrorCode } from "./errors";
import type { OperationScope } from "./identity";
import type { ClientInstanceId } from "./ids";
import type { JsonObject } from "./json";
import { workflowDatasetReferenceSchema } from "./workflows";

// The names and shapes of a Data Store that more than one package reads: the asset kind,
// what its operations and jobs are called, and the handle a caller reaches the rows of one
// store through. The store is in `@work-shape/catalyst-data-stores`. A Knowledge Base, which a Data
// Store can back, is in `knowledge.ts`.

/** The asset kind of a Data Store. Spec: data-stores-and-knowledge-bases.md, build order DS-1. */
export const DATA_STORE_ASSET_KIND = "data_store";

/** The file of a Data Store's folder that holds its definition. Spec: One data store primitive. */
export const DATA_STORE_MANIFEST_FILE = "store.yaml";

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
  execute: "data_store.execute",
  records: "data_store.records"
} as const satisfies AssetKindActions & { insert: string; execute: string; records: string };

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
 * The scope a credential needs for each verb over HTTP. Rows have scopes of their own;
 * `describe` reads the store's definition and stays under `config_assets:read`. A scope only
 * caps the key: the grants of its holder still decide.
 */
export const DATA_STORE_OPERATION_SCOPES = {
  query: "data_store_rows:read",
  insert: "data_store_rows:write",
  load: "data_store_rows:write",
  describe: "config_assets:read",
  preview_rows: "data_store_rows:read"
} as const satisfies Record<DataStoreOperationVerb, OperationScope>;

/**
 * What `insert` does with a row that a unique constraint of the table refuses. `fail` refuses
 * the whole call and adds no row. `skip` leaves such a row out and adds the others, against
 * every unique constraint of the table, the primary key among them.
 *
 * The idempotency key of a step protects one run: a retried step run answers with its first
 * result. It does not protect a second run. `skip` on a table with a unique constraint over
 * what makes a row the same row is what makes a rerun, and next month's run, safe.
 */
export { DATA_STORE_INSERT_CONFLICT_MODES } from "@work-shape/catalyst-asset-schemas";

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
export { DATA_STORE_LOAD_CONFLICT_MODES } from "@work-shape/catalyst-asset-schemas";

export type DataStoreLoadConflictMode = (typeof DATA_STORE_LOAD_CONFLICT_MODES)[number];

/** The right a `load` needs beside `data_store.insert` where it changes or removes rows. */
export const DATA_STORE_LOAD_CHANGE_RIGHT = DATA_STORE_ACTIONS.execute;

/** Defaults for the operator's atomic-load ceilings; release config may raise them. */
export const DATA_STORE_LOAD_DEFAULT_LIMITS = {
  rows: 100_000,
  bytes: 67_108_864,
  timeoutMs: 600_000
} as const;
/** Whole-cursor deadline for a Workflow query; the operator may raise it. */
export const DATA_STORE_QUERY_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * The input of `data_store.<id>.load`, which takes a dataset of a Workflow Run into one table
 * in one transaction, once per step run. Reserved: the slice that brings datasets runs it.
 * Spec: Loading a dataset.
 */
export const dataStoreLoadInputSchema = z
  .strictObject({
    table: z.string().min(1),
    /** The reference of the dataset as the step data holds it. */
    dataset: workflowDatasetReferenceSchema,
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
export { DATA_STORE_SCALAR_TYPES } from "@work-shape/catalyst-asset-schemas";

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
 * The job kinds of the store. `provision` creates the database and the roles of a new store,
 * `migrate` applies the pending migrations of a publish, `measure_size` records the size of
 * every store once a day, `upgrade_owned` queues the migration of every store a Knowledge Base
 * owns whose tables are behind the release, at each start, and `drop` removes the database,
 * the roles and the record of a store whose Knowledge Base was deleted. Spec: One data store
 * primitive; Knowledge Base on top.
 */
export const DATA_STORE_JOB_KINDS = {
  provision: "data_store.provision",
  migrate: "data_store.migrate",
  measureSize: "data_store.measure_size",
  upgradeOwned: "data_store.upgrade_owned",
  drop: "data_store.drop"
} as const;

export type DataStoreJobKind = (typeof DATA_STORE_JOB_KINDS)[keyof typeof DATA_STORE_JOB_KINDS];

/**
 * What the platform keeps of each Data Store, as `PlatformStores.dataStores`: where it lives and
 * the level it is at. It is bound to a transaction like every store of the platform. A caller
 * that reads and then writes does both in one transaction.
 */
export interface DataStoreRecordsStore {
  /** `lock` holds the row until the surrounding transaction ends. */
  getDataStore(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
    lock?: true;
  }): Promise<DataStoreRecord | undefined>;
  /** The record that holds the name, retired or not. */
  findDataStoreByName(input: {
    clientInstanceId: ClientInstanceId;
    name: string;
  }): Promise<DataStoreRecord | undefined>;
  /** The records of the instance in the order of their names, at most `limit`. */
  listDataStores(input: {
    clientInstanceId: ClientInstanceId;
    limit: number;
  }): Promise<DataStoreRecord[]>;
  /**
   * The records that name the database or one of the roles, whatever their status. A drop
   * reads them first, so that it drops nothing the record of another store names.
   */
  listDataStoresNaming(input: {
    clientInstanceId: ClientInstanceId;
    database: string;
    roles: readonly string[];
  }): Promise<DataStoreRecord[]>;
  /** Inserts the record, or replaces the one of the same id. */
  putDataStore(record: DataStoreRecord): Promise<void>;
  /**
   * Removes the record, once the database it names is dropped. Only the store a Knowledge Base
   * owns is dropped: the record of a store of its own asset outlives the asset.
   */
  deleteDataStore(input: { clientInstanceId: ClientInstanceId; id: string }): Promise<void>;
}

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

/**
 * Whether an App owned by `app` may reach a Data Store owned by `store`: a store on the
 * instance, or one of the App's own workspace. A publish refuses any other store as
 * `data_store_unavailable`, and what describes a revision before a publish names no more of it
 * than that. Spec: apps-and-pages.md, Named actions.
 */
export function appReachesDataStore(app: AssetScope, store: AssetScope): boolean {
  return (
    store.kind !== "workspace" ||
    (app.kind === "workspace" && store.workspaceId === app.workspaceId)
  );
}

/**
 * Why a named action of an App cannot reach a Data Store, as `details.reason` of the error
 * and as the reason the run of a failed call keeps. Each has the error code it is answered
 * with. Spec: apps-and-pages.md, Named actions; acceptance check 12.
 */
const DATA_STORE_REFUSALS = {
  /** No published store of the name stands where the App may reach it: none, or a deleted one. */
  data_store_unavailable: "NOT_FOUND",
  /** A Page of a conversation is no App: only an App's manifest binds a store. */
  data_store_needs_app: "CONFLICT",
  /** The store is below the migration level the App's manifest asks for. */
  data_store_below_min_schema: "CONFLICT",
  /** An action reaches a store the manifest of its App does not list. */
  data_store_not_listed: "VALIDATION_FAILED"
} as const satisfies Record<string, AppErrorCode>;

export type DataStoreRefusal = keyof typeof DATA_STORE_REFUSALS;

/** What a refusal names beside the store: the two levels, or the action that reaches it. */
interface DataStoreRefusalFacts {
  minSchema?: number;
  level?: number;
  action?: string;
}

const DATA_STORE_REFUSAL_SENTENCES: Record<
  DataStoreRefusal,
  (store: string, about: DataStoreRefusalFacts) => string
> = {
  data_store_unavailable: (store) =>
    `The Data Store '${store}' is not available: no published Data Store of that name is in the App's workspace or on the instance. It may have been deleted.`,
  data_store_needs_app: (store) =>
    `A Page of a conversation cannot reach the Data Store '${store}': a Data Store is bound by the manifest of an App. Save the Page as an App.`,
  data_store_below_min_schema: (store, { minSchema, level }) =>
    `The App needs the Data Store '${store}' at migration level ${minSchema} (minSchema) and the store is at level ${level}. Publish the store's migrations first.`,
  data_store_not_listed: (store, { action }) =>
    `The action '${action}' reaches the Data Store '${store}', which the manifest of its App does not list under 'dataStores'. An App reaches what its manifest names and nothing else.`
};

/**
 * The error of an App that cannot reach a Data Store. It carries the reason, the store's name
 * as the manifest wrote it and, where the refusal is about them, the two levels or the name of
 * the action. Nothing of a statement, a value or a row.
 */
export function dataStoreRefusalError(
  reason: DataStoreRefusal,
  store: string,
  about: DataStoreRefusalFacts = {}
): AppError {
  return new AppError(
    DATA_STORE_REFUSALS[reason],
    DATA_STORE_REFUSAL_SENTENCES[reason](store, about),
    { reason, dataStore: store, ...about },
    { exposeMessage: true }
  );
}

/** The reason of an error made by `dataStoreRefusalError`, and of no other error. */
export function dataStoreRefusalOf(error: unknown): DataStoreRefusal | undefined {
  if (!isAppError(error)) return undefined;
  const { details } = error;
  if (typeof details !== "object" || details === null || !("reason" in details)) return undefined;
  const { reason } = details;
  return Object.keys(DATA_STORE_REFUSALS).find(
    (known): known is DataStoreRefusal => known === reason
  );
}

// Frozen separately from the callable row verbs: REC-0 registers no handlers.
export {
  dataStoreRecordsContracts as DATA_STORE_RECORD_OPERATIONS,
  dataStoreRecordsRuleSchema,
  recordEvidenceResultSchema,
  RECORDS_PROPOSE_MAX_ITEMS_PER_CALL,
  RECORDS_PROPOSE_MAX_FIELDS_PER_ITEM,
  RECORDS_FLAGGED_MAX_ITEMS_PER_PAGE,
  RECORD_FIELD_STATES,
  RECORD_FIELD_FAILURE_CODES,
  dataStoreRecordProposalItemSchema,
  dataStoreRecordsProposeInputSchema,
  dataStoreRecordsDecideInputSchema,
  dataStoreRecordsDecideOutputSchema,
  dataStoreRecordsFlaggedInputSchema,
  dataStoreRecordsFlaggedOutputSchema,
  dataStoreRecordFieldSchema,
  type RecordColumn,
  type DataStoreRecordsRule,
  type RecordEvidenceResult,
  type DataStoreRecordProposalItem,
  type DataStoreRecordsProposeInput,
  type DataStoreRecordsDecideInput,
  type DataStoreRecordField,
  type DataStoreRecordsDecideOutput,
  type DataStoreRecordsFlaggedInput,
  type DataStoreRecordsFlaggedOutput
} from "@work-shape/catalyst-asset-schemas";
