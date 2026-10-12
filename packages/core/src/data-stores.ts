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
 * The prefix of every operation on the rows of one Data Store: `data_store.<id>.<verb>`. The
 * name has three parts and the id holds no dot, so it never reads as one of the two-part names
 * of the operations that manage stores, such as `data_store.publish`.
 */
export const DATA_STORE_OPERATION_PREFIX = "data_store.";

/** What an operation on the rows of a Data Store does: `query` reads, `insert` adds rows. */
export const DATA_STORE_OPERATION_VERBS = ["query", "insert"] as const;

export type DataStoreOperationVerb = (typeof DATA_STORE_OPERATION_VERBS)[number];

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

/** A Data Store as a manifest names it. Spec: apps-and-pages.md, Manifest, `dataStores`. */
export interface DataStoreReference {
  /** The id of the store. */
  name: string;
  /** The migration level the caller needs. A store below it is refused. */
  minSchema?: number;
}

/** One value a statement binds. It never becomes part of the statement's text. */
export type DataStoreParameter =
  string | number | boolean | null | readonly (string | number | boolean | null)[];

/** SQL with positional placeholders and the values they are bound to. */
export interface DataStoreStatement {
  sql: string;
  parameters?: readonly DataStoreParameter[];
}

export interface DataStoreRows {
  /** The columns in the order of the statement, present even when no row is. */
  columns: readonly { name: string; type: string }[];
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
