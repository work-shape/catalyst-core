import { DATA_STORE_CONDITIONS, DATA_STORE_STATUSES } from "@work-shape/catalyst-asset-schemas";
import type { ClientInstanceId } from "./ids";
import type { ISODateString } from "./time";

// The platform's record of each Data Store: where its database is, how far its migrations are
// applied and how large it is. The record outlives the store's asset, so that deleting the
// asset never loses the way to a database that still holds rows.

/**
 * `provisioning`: published, its database not complete yet. `ready`: the database exists and
 * the migrations up to `level` are applied; its rows are reached. `retired`: the asset was
 * deleted and the database stays. Whether the last attempt to provision or to migrate ended
 * in an error is `failure`, beside the status: a store whose migration failed is still `ready`
 * at the level it had.
 */
export type DataStoreStatus = (typeof DATA_STORE_STATUSES)[number];

/** One migration a store's database has applied, as its file named and held it. */
export interface DataStoreAppliedMigration {
  number: number;
  name: string;
  /** The SHA-256 of the file's bytes. A published revision may not change an applied file. */
  sha256: string;
}

/** Where the database of a store is. It holds no credential. */
export interface DataStoreLocation {
  host: string;
  port: number;
  database: string;
}

/**
 * What the server leaves open around a store that the platform cannot close itself, for an
 * operator to settle. It is asked anew at every job of the store. A store works with each.
 *
 * - `server_databases_open`: a role of the store can connect to another database of the
 *   server, whose grants are the server's and not the platform's to change.
 * - `sessions_open`: the platform's database role is no superuser, so a query of the store
 *   can see the sessions of the server and end one of its own store.
 * - `temp_files_unbounded`: the platform's database role is no superuser, so it cannot set
 *   `temp_file_limit` on the roles of the store.
 */
export { DATA_STORE_CONDITIONS } from "@work-shape/catalyst-asset-schemas";

export type DataStoreCondition = (typeof DATA_STORE_CONDITIONS)[number];

/** Why the last attempt to provision or to migrate ended. A code and a sentence, never a row value. */
export interface DataStoreFailure {
  code: string;
  message: string;
}

export interface DataStoreRecord {
  /** The id of the store's asset, or of the asset of the Knowledge Base that owns it. */
  id: string;
  clientInstanceId: ClientInstanceId;
  /** The id a manifest and an operation name the store by. Held while the record exists. */
  name: string;
  status: DataStoreStatus;
  location: DataStoreLocation;
  roles: { app: string; migration: string };
  /** The number of the last applied migration. Zero before the first. */
  level: number;
  migrations: DataStoreAppliedMigration[];
  /** The published revision the store is brought to. */
  targetRevision: number;
  sizeLimitBytes: number;
  /** What the last measurement found. Missing before the first. */
  sizeBytes?: number;
  sizeMeasuredAt?: ISODateString;
  /**
   * How many tables the store's schema `public` held at the last measurement, and how many
   * rows the database's planner estimated in all of them: an estimate, not a count. Missing
   * before the first measurement that read them.
   */
  tableCount?: number;
  rowEstimate?: number;
  failure?: DataStoreFailure;
  /** What the last job of the store found open on the server. Empty where nothing is. */
  conditions: DataStoreCondition[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
  retiredAt?: ISODateString;
  /**
   * The id of the Knowledge Base whose documents the store keeps. Such a store has no asset and
   * no migrations of its own: the Knowledge Base's publish makes it, the platform's release
   * brings its tables, and deleting the Knowledge Base drops it. Missing for a store of its own
   * asset.
   */
  ownerKnowledgeBaseId?: string;
}
