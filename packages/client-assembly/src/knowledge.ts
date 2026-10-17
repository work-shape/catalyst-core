import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { RouteRegistration, WorkflowAssetKind } from "@work-shape/catalyst-server";
import {
  AppError,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_DOCUMENT_FORMATS,
  DocumentSourceError,
  KNOWLEDGE_TEXT_FORMATS,
  type ClientInstanceId,
  type KnowledgeQueryEmbedder
} from "@work-shape/catalyst-core";
import type { ModelGateway } from "@work-shape/catalyst-model-provider";
import {
  getModelProviderConfigs,
  connectionConfigSchema,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  createKnowledgeBases,
  knowledgeModule,
  knowledgeOperationName,
  type KnowledgeBases,
  type KnowledgeEmbedding
} from "@work-shape/catalyst-data-stores";
import type { ModuleSeam } from "./module-assembly";

export { knowledgeModule };

/**
 * The embedding models release config approves for Knowledge Bases, every binding of kind
 * `embedding` with the model behind it, and the default, as both seams are given them.
 */
export function knowledgeEmbedding(
  config: Pick<ClientInstanceConfig, "knowledge" | "modelBindings" | "infrastructure">
): KnowledgeEmbedding {
  const defaultBinding = config.knowledge.defaultEmbeddingBinding;
  const providers = getModelProviderConfigs(config);
  const models = config.modelBindings.flatMap((binding) => {
    const model =
      binding.model ?? providers.find((provider) => provider.id === binding.providerId)?.model;
    return binding.kind === "embedding" && binding.dimensions !== undefined && model
      ? [{ bindingId: binding.id, model, dimensions: binding.dimensions }]
      : [];
  });
  return { ...(defaultBinding === undefined ? {} : { defaultBinding }), models };
}

/**
 * How a search embeds its query: one text through the gateway with the purpose
 * `knowledge_query`, with a binding of kind `embedding` that release config has now. A binding
 * it no longer has answers nothing, and the search answers from full text and titles.
 */
function queryEmbedder(
  config: Pick<ClientInstanceConfig, "modelBindings">,
  clientInstanceId: ClientInstanceId,
  gateway: Pick<ModelGateway, "embed">
): KnowledgeQueryEmbedder {
  return async ({ bindingId, text, attribution, correlationId, signal }) => {
    const binding = config.modelBindings.find((candidate) => candidate.id === bindingId);
    if (binding?.kind !== "embedding") return undefined;
    const answer = await gateway.embed({
      binding: { bindingId },
      texts: [text],
      attribution: { kind: "system", purpose: "knowledge_query", ...attribution },
      clientInstanceId,
      correlationId,
      ...(signal ? { signal } : {})
    });
    return answer.vectors[0];
  };
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
    publishQuestion: (input) => knowledgeBases.publishQuestion(input),
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
      | "sync"
      | "sources"
      | "source_items"
      | "locate"
      | "query"
      | "state"
      | "check"
      | "add_files"
      | "list_documents"
      | "retry"
      | "remove_documents"
      | "search",
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
    apiOperations["knowledge_bases.sync"],
    bind("sync", KNOWLEDGE_BASE_ACTIONS.write)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.sources"],
    bind("sources", KNOWLEDGE_BASE_ACTIONS.read)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.source_items"],
    bind("source_items", KNOWLEDGE_BASE_ACTIONS.read)
  );
  routes.resourceOperation(
    apiOperations["knowledge_bases.locate"],
    bind("locate", KNOWLEDGE_BASE_ACTIONS.read)
  );
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
  routes.resourceOperation(
    apiOperations["knowledge_bases.search"],
    bind("search", KNOWLEDGE_BASE_ACTIONS.use)
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
  const sourceJobs = earlier.find((assembly) => assembly.knowledgeSourceJobs)?.knowledgeSourceJobs;
  const knowledgeBases = createKnowledgeBases({
    clientInstanceId: parts.clientInstanceId,
    stores: parts.stores,
    backend,
    documentSourceOffered: (config) => {
      const parsed = connectionConfigSchema.safeParse(config);
      return Boolean(
        parsed.success &&
        parsed.data.enabled &&
        parts.connections?.connectorTypes.get(parsed.data.connectorType)?.documentSource
      );
    },
    sources: earlier.find((assembly) => assembly.knowledgeSources)?.knowledgeSources,
    embedding: knowledgeEmbedding(parts.config),
    documentFormats: parts.modules.isEnabled(DOCUMENTS_MODULE)
      ? KNOWLEDGE_DOCUMENT_FORMATS
      : KNOWLEDGE_TEXT_FORMATS,
    maxDocuments: parts.config.knowledge.maxDocuments,
    logger: parts.logger
  });
  return {
    assetKinds: [workflowAssetKind(knowledgeBases)],
    operationSources: (runtime) => [
      knowledgeBases.operationSource(
        runtime.files,
        queryEmbedder(parts.config, parts.clientInstanceId, runtime.modelGateway)
      )
    ],
    start: (runtime) => {
      const fileJobs = knowledgeBases.fileJobs(runtime.files, runtime.auditRecorder, (call) =>
        runtime.modelGateway.embed(call)
      );
      return {
        routes: [knowledgeRoutes],
        dataToolSources: [knowledgeBases.toolSource],
        jobHandlers: [
          ...fileJobs.handlers,
          ...(runtime.files && sourceJobs
            ? sourceJobs({
                files: runtime.files,
                documentFormats: parts.modules.isEnabled(DOCUMENTS_MODULE)
                  ? KNOWLEDGE_DOCUMENT_FORMATS
                  : KNOWLEDGE_TEXT_FORMATS,
                maxDocuments: parts.config.knowledge.maxDocuments,
                async openSource(name, signal) {
                  const connections = parts.connections;
                  if (!connections)
                    throw new DocumentSourceError("unavailable", "Connections are unavailable");
                  return connections.openDocumentSource(name, signal);
                }
              })
            : [])
        ],
        jobRetries: fileJobs.retries
      };
    }
  };
};
