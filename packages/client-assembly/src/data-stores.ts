import { apiOperations } from "@vivd-catalyst/api-contract";
import type { RouteRegistration, WorkflowAssetKind } from "@vivd-catalyst/chat-server";
import { loadSecretKeyring } from "@vivd-catalyst/connections";
import { AppError } from "@vivd-catalyst/core";
import {
  createDataStores,
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

/** The four verbs of a store as operations of the HTTP API, each named by the store in its path. */
function routesOf({ httpOperations }: DataStores): RouteRegistration {
  return (routes) => {
    routes.operation(apiOperations["data_stores.query"], httpOperations.query);
    routes.operation(apiOperations["data_stores.insert"], httpOperations.insert);
    routes.operation(apiOperations["data_stores.describe"], httpOperations.describe);
    routes.operation(apiOperations["data_stores.preview_rows"], httpOperations.preview_rows);
  };
}

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
      routes: [routesOf(dataStores)],
      dataToolSources: [dataStores.toolSource],
      close: () => dataStores.close()
    })
  };
};
