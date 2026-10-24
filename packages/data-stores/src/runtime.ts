import type {
  AuditRecorder,
  ClientInstanceId,
  JsonObject,
  Logger,
  LocaleCode,
  PlatformStores,
  OperationExecutionContext,
  OperationBatchFailure,
  WorkflowDatasetReference
} from "@work-shape/catalyst-core";
import type { DataStoreCredentials } from "./credentials";
import type { DataStoreServer, DataStoreStatementLimits } from "./server";

/** What an operator sets for the stores of an instance, as release config holds it. */
export interface DataStoreLimits {
  /** The most one store may hold. A store's manifest may name less and never more. */
  sizeLimitBytes: number;
  /** Operator ceilings for one atomic load; defaults come from release config. */
  load?: { rows: number; bytes: number; timeoutMs: number };
  /** Maximum row size of the workflow dataset writer receiving query results. */
  streamRowBytes?: number;
  /** Operator deadline for a query streamed into a Workflow dataset. */
  queryTimeoutMs?: number;
  /** The most connections the platform holds to one store at once. */
  poolMaxConnections: number;
  /**
   * Lower ceilings for one statement as a store's app role. Release config names none yet; a
   * test sets one to meet a ceiling soon.
   */
  statement?: DataStoreStatementLimits;
}

/**
 * The authorized dataset port of the instance. Production binds both the dispatch gate and
 * byte reader to the caller's run, or to the caller's run-data rights for a direct call.
 */
export interface DataStoreDatasetReader {
  /** Checked before any replay as well as at the byte reader. */
  authorize?(input: unknown, context: OperationExecutionContext): Promise<void>;
  /**
   * The rows of the dataset in its order, in parts of whatever size. It throws an `AppError`
   * where the dataset cannot be read, such as one that was deleted.
   */
  read(
    reference: WorkflowDatasetReference,
    signal: AbortSignal | undefined,
    context?: OperationExecutionContext
  ): AsyncIterable<readonly JsonObject[]>;
}

/**
 * The datasets of one Workflow run, outside of an operation call (KBW-1): the ingest pass reads
 * the rows its step was given and writes its failures as a dataset of the same step run. Both
 * are bound to the run: a dataset the run may not read is refused as on its own steps.
 */
export interface WorkflowRunDatasetPort {
  /** Throws an `AppError` where the run may not read the dataset, or it is gone. */
  check(input: { workflowRunId: string; reference: WorkflowDatasetReference }): Promise<void>;
  /** At most `limit` rows from `offset`, in the dataset's order. */
  read(input: {
    workflowRunId: string;
    reference: WorkflowDatasetReference;
    offset: number;
    limit: number;
    signal?: AbortSignal;
  }): Promise<JsonObject[]>;
  /** Writes the rows once per step run and field; a repeated write answers the first. */
  write(input: {
    workflowRunId: string;
    stepRunId: string;
    field: string;
    rowSchema: JsonObject;
    rows: AsyncIterable<JsonObject>;
    signal?: AbortSignal;
  }): Promise<WorkflowDatasetReference>;
}

/** What everything that serves Data Stores in one process is built on. */
export interface DataStoreRuntime {
  /** Instance content locale until Knowledge Bases support a content-language setting. */
  defaultLocale: LocaleCode;
  scopes?: import("@work-shape/catalyst-core").DataScopes;
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  server: DataStoreServer;
  limits: DataStoreLimits;
  credentials: DataStoreCredentials;
  auditRecorder: AuditRecorder;
  /** Where `load` reads authorized rows; absent in a process without dataset storage. */
  datasets?: DataStoreDatasetReader;
  recordFailures?: {
    /** Persist these exact failure rows, including on retries after a rolled-back projection. */
    write(
      items: readonly OperationBatchFailure[],
      context: OperationExecutionContext
    ): Promise<WorkflowDatasetReference>;
  };
  /** A Workflow run's datasets for `knowledge.<id>.ingest`; absent without dataset storage. */
  workflowDatasets?: WorkflowRunDatasetPort;
  /** The stores this process has seen to hold the table of their call records, by id. */
  callRecords: Map<string, Promise<void>>;
  logger: Logger;
}
