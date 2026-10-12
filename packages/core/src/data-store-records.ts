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
export type DataStoreStatus = "provisioning" | "ready" | "retired";

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
 * What provisioning found open on the server and could not close itself, for an operator to
 * settle. `server_databases_open`: the store's roles can connect to `postgres` or
 * `template1`, whose grants are the server's and not the platform's to change.
 * `sessions_open`: the platform's database role is no superuser, so a query of the store can
 * see the sessions of the store and end one. A store works with either.
 */
export const DATA_STORE_CONDITIONS = ["server_databases_open", "sessions_open"] as const;

export type DataStoreCondition = (typeof DATA_STORE_CONDITIONS)[number];

/** Why the last attempt to provision or to migrate ended. A code and a sentence, never a row value. */
export interface DataStoreFailure {
  code: string;
  message: string;
}

export interface DataStoreRecord {
  /** The id of the store's asset. */
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
  failure?: DataStoreFailure;
  /** What the last provisioning found open. Empty where nothing is. */
  conditions: DataStoreCondition[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
  retiredAt?: ISODateString;
}
