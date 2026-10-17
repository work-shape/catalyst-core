import {
  AppError,
  ASSET_OWNER_KINDS,
  defineAssetKind,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  type ActorAccess,
  type AuditRecorder,
  type ClientInstanceId,
  type DataToolSource,
  type KnowledgeBackend,
  type KnowledgeDocumentFormat,
  type KnowledgeFiles,
  type Logger,
  type OperationSource,
  type PlatformStores,
  type JobRetry,
  type RegisteredAssetKind,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import {
  KNOWLEDGE_BASE_NAME_MAX_LENGTH,
  KNOWLEDGE_BASE_NAME_PATTERN,
  KNOWLEDGE_BASE_NAME_RULE,
  knowledgeBaseDefinitionSchema,
  knowledgeTargetOf,
  semanticSearchIssue,
  type KnowledgeEmbedding
} from "./definition";
import { createKnowledgeRemovalJobs, enqueueKnowledgeRemoval } from "./removal";
import { createKnowledgeFileCleanupJobs } from "./file-cleanup";
import { createKnowledgeIndexJobHandler } from "./index-job";
import { createKnowledgeOperationSource, createKnowledgeToolSource } from "./operations";
import { keepKnowledgeCheck, type KnowledgeRuntime } from "./runtime";

export { knowledgeOperationName } from "./operations";

/** What the Knowledge Bases of one process are made of, for the assembly to put in place. */
export interface KnowledgeBases {
  /**
   * The kind `knowledge_base`: a definition that describes tables of a Data Store, or keeps
   * documents in a store of its own, with a draft and a published revision. A workspace or the
   * instance owns one.
   */
  readonly assetKind: RegisteredAssetKind<typeof KNOWLEDGE_BASE_ASSET_KIND>;
  /**
   * What a publish does beside moving the published pointer, with `stores` bound to the
   * transaction of the publish: the backend is asked to serve the revision, `replaced` being
   * the revision published before, and what its check found is kept. On a Data Store the
   * publisher must be let to hand its rows on and every described table must be readable; the
   * built-in backend makes the store the Knowledge Base owns. A throw refuses the publish.
   */
  publish(
    stores: PlatformStores,
    input: {
      access: ActorAccess;
      assetId: string;
      revision: number;
      config: unknown;
      replaced: unknown;
    }
  ): Promise<void>;
  /**
   * What deleting the asset does: its last check goes, and what the backend held for it: on a
   * Data Store its access with the role it read as, and no table or row; on the built-in
   * backend the store it owned, which a job drops with every row.
   */
  retire(stores: PlatformStores, assetId: string, published: unknown): Promise<void>;
  /**
   * The operations of every Knowledge Base, with where added files come from and their copies
   * go: what the process has once its call path is built.
   */
  operationSource(files: KnowledgeFiles | undefined): OperationSource;
  /**
   * The jobs of the documents of Knowledge Bases, where the process keeps files: the one that
   * removes the copies a call of `add_files` left without documents, and the index job
   * (`knowledge_base.index`). The extract job is the document worker's.
   */
  fileJobs(
    files: KnowledgeFiles | undefined,
    auditRecorder: AuditRecorder
  ): {
    handlers: RegisteredJobHandler[];
    retries: JobRetry[];
  };
  /** Describes the one knowledge tool to an agent that lists Knowledge Bases. */
  readonly toolSource: DataToolSource;
}

export function createKnowledgeBases(input: {
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  /** Where the described tables are read and the owned stores made. */
  backend: KnowledgeBackend;
  /** The embedding model release config approves for Knowledge Bases (`knowledge`), if any. */
  embedding: KnowledgeEmbedding;
  /** The formats a file added to a Knowledge Base may be in on this instance. */
  documentFormats: readonly KnowledgeDocumentFormat[];
  /** `knowledge.maxDocuments` of release config. */
  maxDocuments: number;
  logger: Logger;
  now?: () => Date;
}): KnowledgeBases {
  const runtime: KnowledgeRuntime = {
    clientInstanceId: input.clientInstanceId,
    stores: input.stores,
    backend: input.backend,
    documentFormats: input.documentFormats,
    maxDocuments: input.maxDocuments,
    logger: input.logger,
    now: input.now ?? (() => new Date())
  };
  return {
    assetKind: defineAssetKind({
      kind: KNOWLEDGE_BASE_ASSET_KIND,
      plural: "knowledge_bases",
      schema: knowledgeBaseDefinitionSchema,
      nameRule: {
        pattern: KNOWLEDGE_BASE_NAME_PATTERN,
        maxLength: KNOWLEDGE_BASE_NAME_MAX_LENGTH,
        description: KNOWLEDGE_BASE_NAME_RULE
      },
      actions: KNOWLEDGE_BASE_ACTIONS,
      lifecycle: "draft_published",
      owners: [...ASSET_OWNER_KINDS],
      validate: () => [],
      // Searching by meaning is the instance's to offer, so a stored definition that asks for it
      // is no reason to refuse a write to another.
      validateWrite: (context, knowledgeBases) =>
        knowledgeBases
          .filter((knowledgeBase) => context.changes(KNOWLEDGE_BASE_ASSET_KIND, knowledgeBase.name))
          .flatMap((knowledgeBase) => semanticSearchIssue(knowledgeBase, input.embedding) ?? [])
          .map((message) => ({ message })),
      summarize: (knowledgeBase) => ({
        name: knowledgeBase.name,
        title: knowledgeBase.title,
        description: knowledgeBase.description
      })
    }),
    async publish(stores, { access, assetId, revision, config, replaced }) {
      const target = knowledgeTargetOf(knowledgeBaseDefinitionSchema.parse(config), assetId);
      const before = knowledgeBaseDefinitionSchema.safeParse(replaced);
      const previous = before.success ? knowledgeTargetOf(before.data, assetId) : undefined;
      // What the old backend holds would stay behind: the documents of a store the Knowledge
      // Base owns, or a role that reads a Data Store.
      if (previous && previous.backend !== target.backend) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Knowledge Base '${target.name}' is published ${previous.backend === "builtin" ? "with documents in a store of its own" : "on a Data Store"}, and a published Knowledge Base keeps its backend. Make a new Knowledge Base for the other backend.`,
          { reason: "knowledge_backend_changed" },
          { exposeMessage: true }
        );
      }
      const result = await runtime.backend.publish(stores, { target, replaced: previous, access });
      await keepKnowledgeCheck(runtime, stores, { assetId, revision }, result);
    },
    async retire(stores, assetId, published) {
      await stores.knowledgeBases.deleteKnowledgeBaseState({
        clientInstanceId: input.clientInstanceId,
        assetId
      });
      const definition = knowledgeBaseDefinitionSchema.safeParse(published);
      // A Knowledge Base never published was never let to read anything.
      if (definition.success) {
        const target = knowledgeTargetOf(definition.data, assetId);
        await runtime.backend.retire(stores, target);
        if (target.backend === "builtin") await enqueueKnowledgeRemoval(stores, runtime, target);
      }
    },
    operationSource: (files) =>
      createKnowledgeOperationSource(files ? { ...runtime, files } : runtime),
    fileJobs: (files, auditRecorder) => {
      const cleanup = createKnowledgeFileCleanupJobs(runtime, files);
      const removal = createKnowledgeRemovalJobs(runtime, files, auditRecorder);
      return {
        handlers: [
          ...cleanup.handlers,
          ...removal.handlers,
          ...(files ? [createKnowledgeIndexJobHandler(runtime, { files, auditRecorder })] : [])
        ],
        retries: [...cleanup.retries, ...removal.retries]
      };
    },
    toolSource: createKnowledgeToolSource(runtime)
  };
}
