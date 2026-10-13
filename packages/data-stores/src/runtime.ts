import type {
  AuditRecorder,
  ClientInstanceId,
  JsonObject,
  Logger,
  PlatformStores,
  WorkflowDatasetReference
} from "@vivd-catalyst/core";
import type { DataStoreCredentials } from "./credentials";
import type { DataStoreServer, DataStoreStatementLimits } from "./server";

/** What an operator sets for the stores of an instance, as release config holds it. */
export interface DataStoreLimits {
  /** The most one store may hold. A store's manifest may name less and never more. */
  sizeLimitBytes: number;
  /** The most connections the platform holds to one store at once. */
  poolMaxConnections: number;
  /**
   * Lower ceilings for one statement as a store's app role. Release config names none yet; a
   * test sets one to meet a ceiling soon.
   */
  statement?: DataStoreStatementLimits;
}

/**
 * Where a load reads the rows of a dataset from. The slice that brings the datasets of
 * Workflow Runs gives it; a process without one refuses `load` as `not_supported_yet`.
 */
export interface DataStoreDatasetReader {
  /**
   * The rows of the dataset in its order, in parts of whatever size. It throws an `AppError`
   * where the dataset cannot be read, such as one that was deleted.
   */
  read(
    reference: WorkflowDatasetReference,
    signal: AbortSignal | undefined
  ): AsyncIterable<readonly JsonObject[]>;
}

/** What everything that serves Data Stores in one process is built on. */
export interface DataStoreRuntime {
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  server: DataStoreServer;
  limits: DataStoreLimits;
  credentials: DataStoreCredentials;
  auditRecorder: AuditRecorder;
  /** Where `load` reads the rows of a dataset from. Missing until the datasets of Workflow Runs exist. */
  datasets?: DataStoreDatasetReader;
  /** The stores this process has seen to hold the table of their call records, by id. */
  callRecords: Map<string, Promise<void>>;
  logger: Logger;
}
