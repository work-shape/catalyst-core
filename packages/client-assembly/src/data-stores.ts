import { apiOperations } from "@vivd-catalyst/api-contract";
import type { RouteRegistration, WorkflowAssetKind } from "@vivd-catalyst/chat-server";
import { loadSecretKeyring } from "@vivd-catalyst/connections";
import {
  AppError,
  DATA_STORE_ACTIONS,
  DATA_STORE_OPERATION_RIGHTS,
  dataStoreOperationName,
  type DataStoreOperationVerb
} from "@vivd-catalyst/core";
import {
  createDataStores,
  dataStoreStateOperationName,
  dataStoresModule,
  sizeLimitBytes,
  type DataStores
} from "@vivd-catalyst/data-stores";
import { PLATFORM_SECRET_NAMES } from "./infrastructure";
import type { ModuleSeam } from "./module-assembly";

export { dataStoresModule };

/** The kind `data_store` as the asset workflow of the API registers it. */
function workflowAssetKind(dataStores: DataStores): WorkflowAssetKind {
  return {
    ...dataStores.assetKind,
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    manifestOfFiles: (files) => dataStores.readFiles(files),
    // The definition the files were read into is the whole config of the revision.
    configOfFiles: ({ manifest }) => manifest,
    onPublish: ({ stores, ...published }) => dataStores.publish(stores, published),
    onRemove: ({ stores, assetId }) => dataStores.retire(stores, assetId)
  };
}

/** What a caller who may read stores is told of an id no store has. */
const STORE_NOT_AVAILABLE = "Data Store is not available";

/**
 * The routes to the rows of a store. Each names the store in its path and runs as that
 * store's own operation, `data_store.<id>.<verb>`: the verb is the route's, never the caller's.
 */
const dataStoreRoutes: RouteRegistration = (routes) => {
  const bind = (verb: DataStoreOperationVerb) => ({
    target: ({ store, ...input }: { store: string }) => ({
      operation: dataStoreOperationName(store, verb),
      input
    }),
    right: DATA_STORE_OPERATION_RIGHTS[verb],
    notFound: STORE_NOT_AVAILABLE
  });
  routes.resourceOperation(apiOperations["data_stores.query"], bind("query"));
  routes.resourceOperation(apiOperations["data_stores.insert"], bind("insert"));
  routes.resourceOperation(apiOperations["data_stores.describe"], bind("describe"));
  routes.resourceOperation(apiOperations["data_stores.preview_rows"], bind("preview_rows"));
  // The state of a store is its own operation, which reads no row and no database of a store.
  routes.resourceOperation(apiOperations["data_stores.get"], {
    target: ({ store }) => ({ operation: dataStoreStateOperationName(store), input: {} }),
    right: DATA_STORE_ACTIONS.read,
    notFound: STORE_NOT_AVAILABLE
  });
};

/**
 * What an instance with the module `dataStores` on has for its Data Stores: the kind, the
 * operations on the rows of each store with their routes and their tools for agents, and the
 * jobs that provision, migrate and measure.
 */
export const assembleDataStores: ModuleSeam = async (parts) => {
  const { config, modules, secrets } = parts;
  if (!modules.isEnabled(dataStoresModule.name)) return undefined;
  if (config.secretStore.keys.length === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Data Stores keep the passwords of their database roles in the Secret Store: name a key under 'secretStore.keys', or turn 'modules.dataStores.enabled' off"
    );
  }
  const dataStores = createDataStores({
    clientInstanceId: parts.clientInstanceId,
    stores: parts.stores,
    databaseUrl: await secrets.resolve(PLATFORM_SECRET_NAMES.databaseUrl),
    keyring: await loadSecretKeyring({ keys: config.secretStore.keys, secrets }),
    limits: {
      sizeLimitBytes: sizeLimitBytes(config.dataStores.sizeLimit),
      poolMaxConnections: config.dataStores.poolMaxConnections
    },
    logger: parts.logger
  });
  return {
    assetKinds: [workflowAssetKind(dataStores)],
    operationSources: () => [dataStores.operationSource],
    start: () => ({
      jobHandlers: dataStores.jobHandlers,
      schedules: dataStores.schedules,
      jobRetries: dataStores.jobRetries,
      routes: [dataStoreRoutes],
      dataToolSources: [dataStores.toolSource],
      close: () => dataStores.close()
    })
  };
};
