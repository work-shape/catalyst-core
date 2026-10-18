import { createHash } from "node:crypto";
import { createWorkflowDatasets, WorkflowStepFailure } from "@work-shape/catalyst-workflows";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { RouteRegistration, WorkflowAssetKind } from "@work-shape/catalyst-server";
import { loadSecretKeyring } from "@work-shape/catalyst-connections";
import {
  AppError,
  operationBatchFailureSchema,
  DATA_STORE_ACTIONS,
  DATA_STORE_OPERATION_RIGHTS,
  dataStoreOperationName,
  dataStoreLoadInputSchema,
  type WorkflowDatasetReference,
  type OperationExecutionContext,
  type DataStoreOperationVerb
} from "@work-shape/catalyst-core";
import {
  createDataStores,
  dataStorePageOperationName,
  dataStoreStateOperationName,
  dataStoresModule,
  sizeLimitBytes,
  type DataStores
} from "@work-shape/catalyst-data-stores";
import { PLATFORM_SECRET_NAMES } from "./infrastructure";
import { knowledgeEmbedding } from "./knowledge";
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
    onPublish: ({ stores, assetId, revision, config }) =>
      dataStores.publish(stores, { assetId, revision, config }),
    onRemove: ({ stores, assetId }) => dataStores.retire(stores, assetId)
  };
}

/** What a caller who may read stores is told of an id no store has. */
const STORE_NOT_AVAILABLE = "Data Store is not available";

/**
 * The routes to the rows of a store. Each names the store in its path and runs as that
 * store's own operation, `data_store.<id>.<verb>`: the verb is the route's, never the caller's.
 */
const dataStoreRoutes =
  (dataStores: DataStores): RouteRegistration =>
  (routes) => {
    registerStoreRoutes(routes);
    // The list is of what the caller may read: the right is asked of each store.
    routes.operation(apiOperations["data_stores.list"], {
      authorize: () => ({ allowed: true }),
      module: dataStoresModule.name,
      execute: (_input, { access }) => dataStores.list(access)
    });
    // Whoever uses an App reads where its data comes from: the right is asked of the App.
    routes.operation(apiOperations["data_stores.app_sources"], {
      authorize: () => ({ allowed: true }),
      module: dataStoresModule.name,
      execute: (input, { access }) => dataStores.appSources(access, input.app, input.revision)
    });
  };

const registerStoreRoutes: RouteRegistration = (routes) => {
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
  // The reads of a store's page, each the store's own operation of the same name.
  const page = (part: "rows" | "value" | "used_by") => ({
    target: ({ store, ...input }: { store: string }) => ({
      operation: dataStorePageOperationName(store, part),
      input
    }),
    right: DATA_STORE_ACTIONS.read,
    notFound: STORE_NOT_AVAILABLE
  });
  routes.resourceOperation(apiOperations["data_stores.rows"], page("rows"));
  routes.resourceOperation(apiOperations["data_stores.value"], page("value"));
  routes.resourceOperation(apiOperations["data_stores.used_by"], page("used_by"));
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
  function datasetReadFailure(error: unknown): never {
    if (error instanceof WorkflowStepFailure)
      throw new AppError(error.code === "FORBIDDEN" ? "FORBIDDEN" : "NOT_FOUND", error.message, {
        reason: error.code
      });
    throw error;
  }
  let datasets: ReturnType<typeof createWorkflowDatasets> | undefined;
  const openDataset = (
    reference: WorkflowDatasetReference,
    context: OperationExecutionContext,
    signal?: AbortSignal
  ) => {
    if (!datasets) throw new AppError("NOT_FOUND", "Dataset storage is not available");
    return datasets
      .reader({
        id: reference.$dataset,
        reference,
        ...(context.origin.kind === "workflow"
          ? { runId: context.origin.workflowRunId }
          : { access: context.access }),
        ...(signal ? { signal } : {})
      })
      .catch(datasetReadFailure);
  };
  const dataStores = createDataStores({
    clientInstanceId: parts.clientInstanceId,
    stores: parts.stores,
    databaseUrl: await secrets.resolve(PLATFORM_SECRET_NAMES.databaseUrl),
    keyring: await loadSecretKeyring({ keys: config.secretStore.keys, secrets }),
    limits: {
      sizeLimitBytes: sizeLimitBytes(config.dataStores.sizeLimit),
      poolMaxConnections: config.dataStores.poolMaxConnections,
      load: config.dataStores.load,
      streamRowBytes: config.workflows.datasets.rowBytes,
      queryTimeoutMs: config.dataStores.queryTimeoutMs
    },
    datasets: {
      async authorize(input, context) {
        await openDataset(dataStoreLoadInputSchema.parse(input).dataset, context);
      },
      async *read(reference, signal, context) {
        if (!context) throw new AppError("FORBIDDEN", "Dataset loads need a caller");
        try {
          const reader = await openDataset(reference, context, signal);
          for await (const row of reader.rows) yield [row];
        } catch (error) {
          datasetReadFailure(error);
        }
      }
    },
    recordFailures: {
      async write(items, context) {
        if (!datasets) throw new AppError("CONFLICT", "Dataset storage is not available");
        if (context.origin.kind !== "workflow")
          throw new AppError(
            "VALIDATION_FAILED",
            context.runtime.locale === "de"
              ? "`records.propose` läuft nur als Schritt eines Workflow Runs."
              : "`records.propose` runs only as a step of a Workflow Run.",
            { reason: "workflow_dataset_owner_required" }
          );
        const run = await parts.stores.workflowRuns.readRun({
          clientInstanceId: parts.clientInstanceId,
          id: context.origin.workflowRunId
        });
        const stepRun = await parts.stores.workflowRuns.getStepRun({
          clientInstanceId: parts.clientInstanceId,
          id: context.origin.stepRunId
        });
        if (!run || !stepRun || stepRun.runId !== run.id)
          throw new AppError("NOT_FOUND", "The Workflow step is not available");
        return datasets.write({
          run,
          stepRun,
          // An aborted projection may retry after catalog/source validation changed.
          // Completed datasets are immutable, so only identical failure rows share a field.
          field: `failures.${createHash("sha256").update(JSON.stringify(items)).digest("hex")}`,
          rowSchema: z
            .record(z.string(), z.json())
            .parse(z.toJSONSchema(operationBatchFailureSchema)),
          rows: (async function* () {
            yield* items;
          })(),
          ...(context.runtime.signal ? { signal: context.runtime.signal } : {})
        });
      }
    },
    embedding: knowledgeEmbedding(config),
    logger: parts.logger
  });
  return {
    assetKinds: [workflowAssetKind(dataStores)],
    knowledgeBackend: dataStores.knowledgeBackend,
    knowledgeSourceJobs: dataStores.knowledgeSourceJobs,
    knowledgeSources: dataStores.knowledgeSources,
    publishNarrativeData: dataStores.publishNarrativeData,
    operationSources: () => [dataStores.operationSource],
    start: ({ files }) => {
      if (files) {
        datasets = createWorkflowDatasets({
          clientInstanceId: parts.clientInstanceId,
          stores: parts.stores,
          objects: files.objects,
          limits: config.workflows.datasets
        });
      }
      return {
        jobHandlers: dataStores.jobHandlers,
        schedules: dataStores.schedules,
        jobRetries: dataStores.jobRetries,
        routes: [dataStoreRoutes(dataStores)],
        dataToolSources: [dataStores.toolSource],
        close: () => dataStores.close()
      };
    }
  };
};
