import { openKnowledgeDocument } from "./open-document";
import { FIELD_OUTPUT_MIN_TOKENS } from "./field-budget";
import {
  confirmKnowledgeProcessing,
  knowledgeProcessingReview,
  createKnowledgeReprocessHandler
} from "./processing-publish";
import { sourceBoundaryKey } from "./source-boundary";
import { sourcePolicyJob } from "./builtin/source-policy-job";
import { knowledgePublishQuestion } from "./publish-question";
import type { KnowledgeSources } from "./source-port";
import { publishSourcePrincipal } from "./source-principal";
import { enqueueSourceSync, initialSyncIds } from "./builtin/source-lifecycle";
import {
  AppError,
  ASSET_OWNER_KINDS,
  defineAssetKind,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  type ActorAccess,
  type AuditRecorder,
  type AssetScope,
  type ClientInstanceId,
  type DataToolSource,
  type KnowledgeBackend,
  type KnowledgeDocumentFormat,
  type KnowledgeFiles,
  type KnowledgeQueryEmbedder,
  type Logger,
  type LocaleCode,
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
import { createKnowledgeIndexJobHandler, type KnowledgeEmbed } from "./index-job";
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
      confirmProcessing?: string;
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
   * go, and how the query of a search is embedded: what the process has once its call path is
   * built.
   */
  operationSource(
    files: KnowledgeFiles | undefined,
    embedQuery?: KnowledgeQueryEmbedder,
    fieldExtractor?: import("@work-shape/catalyst-core").KnowledgeFieldExtractor
  ): OperationSource;
  /**
   * The jobs of the documents of Knowledge Bases, where the process keeps files: the one that
   * removes the copies a call of `add_files` left without documents, and the index job
   * (`knowledge_base.index`), which embeds through `embed`. The extract job is the document
   * worker's.
   */
  fileJobs(
    files: KnowledgeFiles | undefined,
    auditRecorder: AuditRecorder,
    embed: KnowledgeEmbed
  ): {
    handlers: RegisteredJobHandler[];
    retries: JobRetry[];
  };
  /** Original bytes of a live document; the calling operation checks knowledge_base.use. */
  openDocument(
    files: KnowledgeFiles | undefined,
    knowledgeBase: string,
    documentId: string,
    signal?: AbortSignal
  ): Promise<{
    filename: string;
    contentType: string;
    body: AsyncIterable<Uint8Array>;
    inline?: boolean;
  }>;
  /** Describes the one knowledge tool to an agent that lists Knowledge Bases. */
  readonly toolSource: DataToolSource;
  publishQuestion(input: {
    assetId: string;
    scope: AssetScope;
    config: unknown;
    /** The reader's language. English without it. */
    locale?: LocaleCode;
  }): Promise<string[]>;
}

export function createKnowledgeBases(input: {
  /** Instance content locale until Knowledge Bases support a content-language setting. */
  defaultLocale: LocaleCode;
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  /** Where the described tables are read and the owned stores made. */
  backend: KnowledgeBackend;
  sources?: KnowledgeSources;
  assertFieldBudgetPriced?(): void;
  documentSourceOffered?(config: unknown): boolean;
  /** The embedding model release config approves for Knowledge Bases (`knowledge`), if any. */
  embedding: KnowledgeEmbedding;
  /** The formats a file added to a Knowledge Base may be in on this instance. */
  documentFormats: readonly KnowledgeDocumentFormat[];
  /** `knowledge.maxDocuments` of release config. */
  maxDocuments: number;
  maxPages?: number;
  logger: Logger;
  now?: () => Date;
}): KnowledgeBases {
  const runtime: KnowledgeRuntime = {
    defaultLocale: input.defaultLocale,
    clientInstanceId: input.clientInstanceId,
    stores: input.stores,
    backend: input.backend,
    ...(input.sources ? { sources: input.sources } : {}),
    documentFormats: input.documentFormats,
    maxDocuments: input.maxDocuments,
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
    logger: input.logger,
    now: input.now ?? (() => new Date())
  };
  return {
    async openDocument(files, knowledgeBase, documentId, signal) {
      const asset = await input.stores.configAssets.getConfigAsset({
        clientInstanceId: input.clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: knowledgeBase
      });
      return openKnowledgeDocument(runtime, files, asset, documentId, signal);
    },
    publishQuestion: async (question) => {
      const asset = await input.stores.configAssets.getConfigAsset({
        clientInstanceId: input.clientInstanceId,
        kind: "knowledge_base",
        name: knowledgeBaseDefinitionSchema.parse(question.config).name
      });
      const review = await knowledgeProcessingReview(
        runtime,
        question.config,
        asset?.publishedConfig,
        question.assetId,
        input.embedding,
        true
      );
      return [
        ...(await knowledgePublishQuestion(input.stores, input.clientInstanceId, question)),
        ...(review?.lines ?? [])
      ];
    },
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
    async publish(stores, { access, assetId, revision, config, replaced, confirmProcessing }) {
      const definition = knowledgeBaseDefinitionSchema.parse(config);
      const maxTokens = definition.extraction?.budget.maxTokensPerDocument;
      if (maxTokens !== undefined && maxTokens < FIELD_OUTPUT_MIN_TOKENS)
        throw new AppError(
          "VALIDATION_FAILED",
          input.defaultLocale === "de"
            ? `extraction.budget.maxTokensPerDocument: ${maxTokens} ist kleiner als das Minimum ${FIELD_OUTPUT_MIN_TOKENS} für die Extraktion.`
            : `extraction.budget.maxTokensPerDocument: ${maxTokens} is below the extraction minimum ${FIELD_OUTPUT_MIN_TOKENS}.`,
          {
            reason: "knowledge_field_token_reserve",
            field: "extraction.budget.maxTokensPerDocument",
            value: maxTokens,
            minimum: FIELD_OUTPUT_MIN_TOKENS
          }
        );
      if (definition.extraction?.budget.perMonth !== undefined) input.assertFieldBudgetPriced?.();

      await confirmKnowledgeProcessing(
        runtime,
        stores,
        {
          assetId,
          revision,
          config,
          replaced,
          ...(confirmProcessing ? { confirmProcessing } : {})
        },
        input.embedding
      );
      const target = knowledgeTargetOf(definition, assetId);
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
      const principal = await publishSourcePrincipal(stores, {
        clientInstanceId: input.clientInstanceId,
        assetId,
        name: definition.name,
        access,
        sources: definition.sources ?? [],
        documentSourceOffered: input.documentSourceOffered,
        previous: before.success ? (before.data.sources ?? []) : []
      });
      const result = await runtime.backend.publish(stores, { target, replaced: previous, access });
      await keepKnowledgeCheck(runtime, stores, { assetId, revision }, result);
      const changedSources = (before.success ? (before.data.sources ?? []) : []).filter((old) => {
        const next = definition.sources?.find((source) => source.id === old.id);
        return !next || sourceBoundaryKey(next) !== sourceBoundaryKey(old);
      });
      if (changedSources.length) {
        await stores.jobs.enqueue(
          sourcePolicyJob,
          {
            knowledgeBaseId: assetId,
            knowledgeBase: definition.name,
            revision,
            sourceIds: changedSources.map((source) => source.id)
          },
          { clientInstanceId: input.clientInstanceId, subject: assetId, concurrencyKey: assetId }
        );
        for (const old of changedSources)
          await stores.audit.appendAuditEvent({
            clientInstanceId: input.clientInstanceId,
            type: definition.sources?.some((source) => source.id === old.id)
              ? "knowledge_base.source_narrowed"
              : "knowledge_base.source_removed",
            status: "success",
            subject: assetId,
            correlationId: `${assetId}:${revision}`,
            metadata: { source: old.id }
          });
      }
      if (principal)
        for (const source of definition.sources ?? []) {
          if (before.success && before.data.sources?.some((old) => old.id === source.id)) continue;
          const payload = initialSyncIds(assetId, source.id);
          await stores.operationRuns.create({
            id: payload.operationRunId,
            clientInstanceId: input.clientInstanceId,
            operation: `knowledge.${definition.name}.sync`,
            effect: "changing",
            actor: { kind: "service_principal", id: principal.id, label: principal.displayLabel },
            origin: { kind: "user" },
            target: "live",
            inputHash: "initial",
            correlationId: payload.operationRunId,
            startedAt: runtime.now().toISOString()
          });
          await enqueueSourceSync(stores, runtime, payload);
          await stores.audit.appendAuditEvent({
            clientInstanceId: input.clientInstanceId,
            type: "knowledge_base.source_added",
            status: "success",
            subject: assetId,
            correlationId: payload.operationRunId,
            metadata: { source: source.id, connection: source.connection }
          });
        }
    },
    async retire(stores, assetId, published) {
      const principal = await stores.apiAccess.findServicePrincipalByOwner({
        clientInstanceId: input.clientInstanceId,
        owner: { kind: "knowledge_base", assetId }
      });
      if (principal) {
        await stores.apiAccess.updateServicePrincipal({
          clientInstanceId: input.clientInstanceId,
          servicePrincipalId: principal.id,
          status: "disabled"
        });
        await stores.apiAccess.deleteServicePrincipal({
          clientInstanceId: input.clientInstanceId,
          servicePrincipalId: principal.id
        });
      }
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
    operationSource: (files, embedQuery, fieldExtractor) =>
      createKnowledgeOperationSource({
        ...runtime,
        ...(files ? { files } : {}),
        ...(embedQuery ? { embedQuery } : {}),
        ...(fieldExtractor ? { fieldExtractor } : {})
      }),
    fileJobs: (files, auditRecorder, embed) => {
      const cleanup = createKnowledgeFileCleanupJobs(runtime, files);
      const removal = createKnowledgeRemovalJobs(runtime, files, auditRecorder);
      return {
        handlers: [
          ...cleanup.handlers,
          ...removal.handlers,
          ...(files
            ? [
                createKnowledgeReprocessHandler({ ...runtime, files }),
                createKnowledgeIndexJobHandler(runtime, {
                  files,
                  auditRecorder,
                  embedding: input.embedding,
                  embed
                })
              ]
            : [])
        ],
        retries: [...cleanup.retries, ...removal.retries]
      };
    },
    toolSource: createKnowledgeToolSource(runtime)
  };
}
