export {
  knowledgeDocumentTypesSchema,
  knowledgeProcessingOf,
  validateKnowledgeProcessingOutput
} from "./knowledge/document-types";
export { createSourceWithdrawalApproval } from "./knowledge/source-withdrawal-approval";
import type { KnowledgeSources } from "./knowledge/source-port";
import { createKnowledgeSources } from "./knowledge/builtin/source-queries";
import {
  createKnowledgeSourceJobs,
  type KnowledgeSourceJobsInput
} from "./knowledge/builtin/source-jobs";
import type { SecretKeyring } from "@work-shape/catalyst-connections";
import {
  ASSET_OWNER_KINDS,
  AppError,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_JOB_KINDS,
  DATA_STORE_MANIFEST_FILE,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_JOB_KINDS,
  StoreBackedAuditRecorder,
  defineAssetKind,
  defineModule,
  type ActorAccess,
  type ApprovalRequestHandler,
  type ClientInstanceId,
  type DataToolSource,
  type PublishNarrativeStoredData,
  type JobRetry,
  type JobSchedule,
  type JsonObject,
  type KnowledgeBackend,
  type Logger,
  type LocaleCode,
  type OperationSource,
  type PlatformStores,
  type RegisteredAssetKind,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import { createDataStoreCredentials } from "./credentials";
import {
  DATA_STORE_NAME_MAX_LENGTH,
  DATA_STORE_NAME_PATTERN,
  DATA_STORE_NAME_RULE,
  dataStoreDefinitionSchema,
  readDataStoreFiles
} from "./definition";
import { createDataStoreJobs, publishDataStore, retireDataStore } from "./jobs";
import type { KnowledgeEmbedding } from "./knowledge/definition";
import { createKnowledgeBackend } from "./knowledge/backends";
import { listDataStores } from "./list";
import { appDataSources } from "./used-by";
import { createPublishNarrativeData } from "./publish-narrative-data";
import {
  createDataStoreOperationSource,
  createDataStoreToolSource,
  readStore,
  readStores
} from "./operations";
import { createReviewNoticeHandler } from "./records/review-notice";
import { ensureVectorExtension } from "./provisioning";
import type { DataStoreDatasetReader, DataStoreLimits, DataStoreRuntime } from "./runtime";
import { createDataStoreServer } from "./server";

export { sizeLimitBytes } from "./definition";
export { createKnowledgeBases, knowledgeOperationName, type KnowledgeBases } from "./knowledge";
export { knowledgeBaseReadsClosedConnection } from "./knowledge/outside-reach";
export { uploadFingerprint } from "./knowledge/add-files";
export type { KnowledgeEmbedding } from "./knowledge/definition";
export type { WorkflowRunDatasetPort } from "./runtime";
export {
  KNOWLEDGE_EMBEDDING_BATCH,
  KNOWLEDGE_USAGE_LIMIT_WAIT_MS,
  type KnowledgeEmbed,
  type KnowledgeEmbedCall
} from "./knowledge/index-job";
export {
  chunkKnowledgeText,
  estimateKnowledgeTokens,
  KNOWLEDGE_CHUNK_MAX_TOKENS,
  KNOWLEDGE_CHUNKING_REVISION,
  knowledgeChunkPrefix
} from "./knowledge/builtin/chunking";
export { dataStoreStateOperationName } from "./state";
export { splitSeedStatements } from "./seed-statements";
export type { TestCopyPart } from "./test-copy";

/**
 * The name of a read of a store's page that is no verb of the contract: `rows`, `value` and
 * `used_by`, each `data_store.<id>.<part>`, which the routes of the same name run as.
 */
export function dataStorePageOperationName(
  store: string,
  part: "rows" | "value" | "used_by"
): string {
  return `${DATA_STORE_OPERATION_PREFIX}${store}.${part}`;
}

/**
 * Data Stores: the asset kind `data_store`, a database of the platform per store, the jobs
 * that provision and migrate it and measure its size, and the operations on its rows.
 * Everything listed here is off when the module is off.
 */
export const dataStoresModule = defineModule({
  name: "dataStores",
  kinds: [DATA_STORE_ASSET_KIND],
  tools: ["platform.data_stores.describe", "data_store.use"],
  operations: [
    "conversations.data_stores.add",
    "data_stores.description",
    "data_stores.query",
    "data_stores.insert",
    "data_stores.describe",
    "data_stores.preview_rows",
    "data_stores.get",
    "data_stores.list",
    "data_stores.rows",
    "data_stores.value",
    "data_stores.used_by",
    "data_stores.app_sources",
    "data_stores.test_copy_reset",
    "data_stores.test_copy_delete"
  ],
  jobKinds: Object.values(DATA_STORE_JOB_KINDS)
});

/**
 * Knowledge Bases: the asset kind `knowledge_base` and the operations of each, and the one
 * agent tool over an agent's. A module of its own, because a Knowledge Base on an existing
 * database will need no Data Store. Both its backends so far are Data Stores, one it describes
 * and one it owns, so it needs that module on.
 */
export const knowledgeModule = defineModule({
  name: "knowledge",
  tools: ["knowledge.add_files"],
  jobKinds: Object.values(KNOWLEDGE_JOB_KINDS),
  requires: ["dataStores"],
  kinds: [KNOWLEDGE_BASE_ASSET_KIND],
  operations: [
    "knowledge_bases.sync",
    "knowledge_bases.sources",
    "knowledge_bases.source_items",
    "knowledge_bases.locate",
    "knowledge_bases.get",
    "knowledge_bases.open_document",
    "knowledge_bases.workflow_sources",
    "knowledge_bases.check",
    "knowledge_bases.query",
    "knowledge_bases.add_files",
    "knowledge_bases.upload_file",
    "knowledge_bases.list_documents",
    "knowledge_bases.retry_documents",
    "knowledge_bases.remove_documents",
    "knowledge_bases.reindex"
  ]
});

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
  /**
   * Refuses while a published asset or a live agent uses the store. Otherwise retires it in the delete's
   * transaction; the database and its rows remain for operator cleanup.
   */
  retire(stores: PlatformStores, assetId: string): Promise<void>;
  readonly operationSource: OperationSource;
  /**
   * The published stores the caller may read, each with what its last measurement found. It
   * asks no database of a store.
   */
  list(access: ActorAccess): ReturnType<typeof listDataStores>;
  /**
   * Where the data of one published App comes from, for whoever uses or reads it. `NOT_FOUND`
   * for an App the caller may neither use nor read. With `revision`, what that stored revision
   * would show and to whom, for whoever may change, publish or approve the App.
   */
  appSources(
    access: ActorAccess,
    app: string,
    revision?: number
  ): ReturnType<typeof appDataSources>;
  /** What the publish question's sentence says of stored data (PUBQ-1). It reads no store. */
  readonly publishNarrativeData: PublishNarrativeStoredData;
  /** Describes the operations to an agent that lists them as tools. */
  readonly toolSource: DataToolSource;
  readonly jobHandlers: readonly RegisteredJobHandler[];
  /** The Inbox notice of a store whose records wait in "Prüfen" (REC-2). */
  readonly reviewNotice: ApprovalRequestHandler;
  readonly schedules: readonly JobSchedule[];
  readonly jobRetries: readonly JobRetry[];
  /**
   * The backends of Knowledge Bases, on the same pools as the stores' own reads: a Data Store
   * whose tables a Knowledge Base describes, and the store a Knowledge Base without a backend
   * owns.
   */
  readonly knowledgeBackend: KnowledgeBackend;
  readonly knowledgeSources: KnowledgeSources;
  /** Handlers for connector-source ingestion, on the owned-store pools. */
  knowledgeSourceJobs(input: KnowledgeSourceJobsInput): RegisteredJobHandler[];
  /**
   * Creates pgvector in the database of a provisioned store, as the platform's role: for a
   * store a Knowledge Base with semantic search owns, and for no other (ADR-0023). Throws with
   * the code `vector_extension_missing` where the server has no pgvector and
   * `vector_extension_not_permitted` where only a superuser may create it and the platform's
   * role is none; `NOT_FOUND` for a store that does not exist or is retired. A store whose
   * migrations use the extension's types needs it before its first migration.
   */
  ensureVectorExtension(storeId: string, signal: AbortSignal): Promise<void>;
  /** Closes the idle connections to the stores. Call it when the process stops. */
  close(): Promise<void>;
}

export function createDataStores(input: {
  /** Instance content locale until Knowledge Bases support a content-language setting. */
  defaultLocale: LocaleCode;
  scopes?: import("@work-shape/catalyst-core").DataScopes;
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
  recordFailures?: DataStoreRuntime["recordFailures"];
  /** A Workflow run's datasets for `knowledge.<id>.ingest` (KBW-1). */
  workflowDatasets?: DataStoreRuntime["workflowDatasets"];
  /** The embedding model release config approves for Knowledge Bases (`knowledge`), if any. */
  embedding?: KnowledgeEmbedding;
  logger: Logger;
}): DataStores {
  const { clientInstanceId, stores, limits, logger } = input;
  const credentials = createDataStoreCredentials({ clientInstanceId, keyring: input.keyring });
  const server = createDataStoreServer({
    clientInstanceId,
    databaseUrl: input.databaseUrl,
    credentials,
    poolMaxConnections: limits.poolMaxConnections,
    ...(limits.statement ? { statementLimits: limits.statement } : {})
  });
  const runtime: DataStoreRuntime = {
    defaultLocale: input.defaultLocale,
    ...(input.scopes ? { scopes: input.scopes } : {}),
    clientInstanceId,
    stores,
    server,
    limits,
    credentials,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
    ...(input.datasets ? { datasets: input.datasets } : {}),
    ...(input.recordFailures ? { recordFailures: input.recordFailures } : {}),
    ...(input.workflowDatasets ? { workflowDatasets: input.workflowDatasets } : {}),
    callRecords: new Map(),
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
      owners: [...ASSET_OWNER_KINDS],
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
    list: (access) => listDataStores(runtime, access),
    appSources: (access, app, revision) => appDataSources(runtime, access, app, revision),
    publishNarrativeData: createPublishNarrativeData(runtime),
    toolSource: createDataStoreToolSource(runtime),
    jobHandlers: jobs.handlers,
    reviewNotice: createReviewNoticeHandler(runtime, {
      one: (name) => readStore(runtime, name),
      all: async () => (await readStores(runtime)).stores
    }),
    schedules: jobs.schedules,
    jobRetries: jobs.retries,
    knowledgeBackend: createKnowledgeBackend(runtime, input.embedding ?? {}),
    knowledgeSources: createKnowledgeSources(runtime),
    knowledgeSourceJobs: (input) => createKnowledgeSourceJobs(runtime, input),
    async ensureVectorExtension(storeId, signal) {
      const record = await stores.dataStores.getDataStore({ clientInstanceId, id: storeId });
      if (!record || record.status === "retired") {
        throw new AppError("NOT_FOUND", `No Data Store has the id '${storeId}'.`);
      }
      await ensureVectorExtension(server, record, signal);
    },
    close: () => server.executor.close()
  };
}
