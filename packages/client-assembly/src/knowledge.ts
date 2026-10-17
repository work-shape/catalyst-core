import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { RouteRegistration, WorkflowAssetKind } from "@work-shape/catalyst-server";
import {
  AppError,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_DOCUMENT_FORMATS,
  KNOWLEDGE_TEXT_FORMATS
} from "@work-shape/catalyst-core";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  createKnowledgeBases,
  knowledgeModule,
  knowledgeOperationName,
  type KnowledgeBases,
  type KnowledgeEmbedding
} from "@work-shape/catalyst-data-stores";
import type { ModuleSeam } from "./module-assembly";

export { knowledgeModule };

/** The embedding model release config approves for Knowledge Bases, as both seams are given it. */
export function knowledgeEmbedding(
  config: Pick<ClientInstanceConfig, "knowledge">
): KnowledgeEmbedding {
  const defaultBinding = config.knowledge.defaultEmbeddingBinding;
  return defaultBinding === undefined ? {} : { defaultBinding };
}

/** The kind `knowledge_base` as the asset workflow of the API registers it. */
function workflowAssetKind(knowledgeBases: KnowledgeBases): WorkflowAssetKind {
  return {
    ...knowledgeBases.assetKind,
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    onPublish: ({ stores, access, assetId, revision, config, replaced }) =>
      knowledgeBases.publish(stores, { access, assetId, revision, config, replaced }),
    onRemove: ({ stores, assetId, published }) => knowledgeBases.retire(stores, assetId, published)
  };
}

/**
 * The module of the document-processing capability. With it on, a Knowledge Base takes PDF and
 * DOCX, which its worker extracts; without it, text files alone.
 */
const DOCUMENTS_MODULE = "documents";

/** What a caller who may read Knowledge Bases is told of an id none has. */
const KNOWLEDGE_BASE_NOT_AVAILABLE = "Knowledge Base is not available";

/**
 * The routes of one Knowledge Base. Each names it in its path and runs as its own operation,
 * `knowledge.<id>.<part>`: the part is the route's, never the caller's.
 */
const knowledgeRoutes: RouteRegistration = (routes) => {
  const bind = (
    part:
      "query" | "state" | "check" | "add_files" | "list_documents" | "retry" | "remove_documents",
    right: string
  ) => ({
    target: ({ knowledgeBase, ...input }: { knowledgeBase: string }) => ({
      operation: knowledgeOperationName(knowledgeBase, part),
      input
    }),
    right,
    notFound: KNOWLEDGE_BASE_NOT_AVAILABLE
  });
  routes.resourceOperation(
    apiOperations["knowledge_bases.query"],
    bind("query", KNOWLEDGE_BASE_ACTIONS.use)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.get"],
    bind("state", KNOWLEDGE_BASE_ACTIONS.read)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.check"],
    bind("check", KNOWLEDGE_BASE_ACTIONS.write)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.add_files"],
    bind("add_files", KNOWLEDGE_BASE_ACTIONS.write)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.list_documents"],
    bind("list_documents", KNOWLEDGE_BASE_ACTIONS.use)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.remove_documents"],
    bind("remove_documents", KNOWLEDGE_BASE_ACTIONS.write)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.retry_documents"],
    bind("retry", KNOWLEDGE_BASE_ACTIONS.write)
  );
};

/**
 * What an instance with the module `knowledge` on has for its Knowledge Bases: the kind, the
 * operations of each with their routes, and the one agent tool over an agent's. The backend
 * is the Data Store, which an earlier seam offers: the module requires `dataStores`.
 */
export const assembleKnowledge: ModuleSeam = (parts, earlier) => {
  if (!parts.modules.isEnabled(knowledgeModule.name)) return undefined;
  const backend = earlier.find((assembly) => assembly.knowledgeBackend)?.knowledgeBackend;
  if (!backend) {
    throw new AppError(
      "INTERNAL",
      "Knowledge Bases need a backend, and no module of this process offers one: the Data Stores seam is assembled before the Knowledge Base seam"
    );
  }
  const knowledgeBases = createKnowledgeBases({
    clientInstanceId: parts.clientInstanceId,
    stores: parts.stores,
    backend,
    embedding: knowledgeEmbedding(parts.config),
    documentFormats: parts.modules.isEnabled(DOCUMENTS_MODULE)
      ? KNOWLEDGE_DOCUMENT_FORMATS
      : KNOWLEDGE_TEXT_FORMATS,
    maxDocuments: parts.config.knowledge.maxDocuments,
    logger: parts.logger
  });
  return {
    assetKinds: [workflowAssetKind(knowledgeBases)],
    operationSources: (runtime) => [knowledgeBases.operationSource(runtime.files)],
    start: (runtime) => {
      const fileJobs = knowledgeBases.fileJobs(runtime.files, runtime.auditRecorder);
      return {
        routes: [knowledgeRoutes],
        dataToolSources: [knowledgeBases.toolSource],
        jobHandlers: fileJobs.handlers,
        jobRetries: fileJobs.retries
      };
    }
  };
};
