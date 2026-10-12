import type { WorkflowAssetKind } from "@vivd-catalyst/chat-server";
import { loadSecretKeyring } from "@vivd-catalyst/connections";
import { AppError, type DataToolSource, type JobRetry } from "@vivd-catalyst/core";
import { createDataStores, dataStoresModule, type DataStores } from "@vivd-catalyst/data-stores";
import { PLATFORM_SECRET_NAMES } from "./infrastructure";
import type { ModuleAssembly, ModuleSeam } from "./module-assembly";

export { dataStoresModule };

/**
 * What the Data Stores of an instance have that `ModuleAssembly` has no place for yet. The
 * seam answers it beside what the assembly takes, so that the assembly reads it from here
 * once it can: the manual retries of the store's jobs where the API registers retries, the
 * tool source where an agent's data tools are described, and `close` where the process stops.
 */
interface DataStoresAssembly extends ModuleAssembly {
  readonly jobRetries: readonly JobRetry[];
  readonly dataTools: DataToolSource;
  close(): Promise<void>;
}

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

/**
 * What an instance with the module `dataStores` on has for its Data Stores: the kind, the
 * operations on the rows of each store, and the jobs that provision, migrate and measure.
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
    logger: parts.logger
  });
  const assembly: DataStoresAssembly = {
    assetKinds: [workflowAssetKind(dataStores)],
    operationSources: [dataStores.operationSource],
    jobHandlers: dataStores.jobHandlers,
    schedules: dataStores.schedules,
    jobRetries: dataStores.jobRetries,
    dataTools: dataStores.toolSource,
    close: () => dataStores.close()
  };
  return assembly;
};
