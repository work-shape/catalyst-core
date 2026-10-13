import type { SecretKeyring } from "@vivd-catalyst/connections";
import {
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_JOB_KINDS,
  DATA_STORE_MANIFEST_FILE,
  StoreBackedAuditRecorder,
  defineAssetKind,
  defineModule,
  type ClientInstanceId,
  type DataToolSource,
  type JobRetry,
  type JobSchedule,
  type JsonObject,
  type Logger,
  type OperationSource,
  type PlatformStores,
  type RegisteredAssetKind,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import { createDataStoreCredentials } from "./credentials";
import {
  DATA_STORE_NAME_MAX_LENGTH,
  DATA_STORE_NAME_PATTERN,
  DATA_STORE_NAME_RULE,
  dataStoreDefinitionSchema,
  readDataStoreFiles
} from "./definition";
import { createDataStoreJobs, publishDataStore, retireDataStore } from "./jobs";
import { createDataStoreOperationSource, createDataStoreToolSource } from "./operations";
import type { DataStoreDatasetReader, DataStoreLimits, DataStoreRuntime } from "./runtime";

export { sizeLimitBytes } from "./definition";
export { dataStoreStateOperationName } from "./state";
import { createDataStoreServer } from "./server";

/**
 * Data Stores: the asset kind `data_store`, a database of the platform per store, the jobs
 * that provision and migrate it and measure its size, and the operations on its rows.
 * Everything listed here is off when the module is off.
 */
export const dataStoresModule = defineModule({
  name: "dataStores",
  kinds: [DATA_STORE_ASSET_KIND],
  operations: [
    "data_stores.query",
    "data_stores.insert",
    "data_stores.describe",
    "data_stores.preview_rows",
    "data_stores.get"
  ],
  jobKinds: Object.values(DATA_STORE_JOB_KINDS)
});

/**
 * Knowledge Bases: the asset kind `knowledge_base`, ingestion, and the search and query
 * operations of each. A module of its own, because a Knowledge Base on an existing database
 * needs no Data Store. It is registered and contributes nothing yet.
 */
export const knowledgeModule = defineModule({ name: "knowledge" });

/** What the Data Stores of one process are made of, for the assembly to put in place. */
export interface DataStores {
  /**
   * The kind `data_store`: a folder with `store.yaml` and `migrations/`, with a draft and a
   * published revision. A workspace or the instance owns a store.
   */
  readonly assetKind: RegisteredAssetKind<typeof DATA_STORE_ASSET_KIND>;
  /** Reads the files of a store's folder into the definition a revision holds. Throws `VALIDATION_FAILED`. */
  readFiles(files: readonly { path: string; bytes: Uint8Array }[]): JsonObject;
  /**
   * What a publish does to the store beside moving the published pointer, with `stores` bound
   * to the transaction of the publish. A throw refuses the publish.
   */
  publish(
    stores: PlatformStores,
    input: { assetId: string; revision: number; config: unknown }
  ): Promise<void>;
  /** What deleting the asset does to the store, in the transaction of the delete: it is retired. */
  retire(stores: PlatformStores, assetId: string): Promise<void>;
  readonly operationSource: OperationSource;
  /** Describes the operations to an agent that lists them as tools. */
  readonly toolSource: DataToolSource;
  readonly jobHandlers: readonly RegisteredJobHandler[];
  readonly schedules: readonly JobSchedule[];
  readonly jobRetries: readonly JobRetry[];
  /** Closes the idle connections to the stores. Call it when the process stops. */
  close(): Promise<void>;
}

export function createDataStores(input: {
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  /** The address of the platform database: its server is where the stores are made. */
  databaseUrl: string;
  /** The keys of the Secret Store, which keeps the passwords of the store roles. */
  keyring: SecretKeyring;
  /** The limits of release config (`dataStores`). */
  limits: DataStoreLimits;
  /**
   * Where `load` reads the rows of a dataset of a Workflow Run from. Without one a load is
   * refused as `not_supported_yet`.
   */
  datasets?: DataStoreDatasetReader;
  logger: Logger;
}): DataStores {
  const { clientInstanceId, stores, limits, logger } = input;
  const credentials = createDataStoreCredentials({ clientInstanceId, keyring: input.keyring });
  const server = createDataStoreServer({
    clientInstanceId,
    databaseUrl: input.databaseUrl,
    credentials,
    secretRows: stores.connections,
    poolMaxConnections: limits.poolMaxConnections
  });
  const runtime: DataStoreRuntime = {
    clientInstanceId,
    stores,
    server,
    limits,
    credentials,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
    ...(input.datasets ? { datasets: input.datasets } : {}),
    logger
  };
  const jobs = createDataStoreJobs(runtime);
  return {
    assetKind: defineAssetKind({
      kind: DATA_STORE_ASSET_KIND,
      plural: "data_stores",
      schema: dataStoreDefinitionSchema,
      nameRule: {
        pattern: DATA_STORE_NAME_PATTERN,
        maxLength: DATA_STORE_NAME_MAX_LENGTH,
        description: DATA_STORE_NAME_RULE
      },
      actions: DATA_STORE_ACTIONS,
      lifecycle: "draft_published",
      representation: "files",
      manifestFile: DATA_STORE_MANIFEST_FILE,
      owners: ["instance", "workspace"],
      validate: () => [],
      summarize: (store) => ({
        name: store.name,
        title: store.title,
        ...(store.description === undefined ? {} : { description: store.description })
      })
    }),
    readFiles: readDataStoreFiles,
    publish: (bound, { assetId, revision, config }) =>
      publishDataStore(runtime, bound, {
        storeId: assetId,
        revision,
        definition: dataStoreDefinitionSchema.parse(config)
      }),
    retire: (bound, assetId) => retireDataStore(runtime, bound, assetId),
    operationSource: createDataStoreOperationSource(runtime),
    toolSource: createDataStoreToolSource(runtime),
    jobHandlers: jobs.handlers,
    schedules: jobs.schedules,
    jobRetries: jobs.retries,
    close: () => server.executor.close()
  };
}
