import {
  AppError,
  defineAssetKind,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  type ActorAccess,
  type ClientInstanceId,
  type DataToolSource,
  type KnowledgeBackend,
  type Logger,
  type OperationSource,
  type PlatformStores,
  type RegisteredAssetKind
} from "@vivd-catalyst/core";
import {
  KNOWLEDGE_BASE_NAME_MAX_LENGTH,
  KNOWLEDGE_BASE_NAME_PATTERN,
  KNOWLEDGE_BASE_NAME_RULE,
  knowledgeBaseDefinitionSchema,
  knowledgeTargetOf
} from "./definition";
import { createKnowledgeOperationSource, createKnowledgeToolSource } from "./operations";
import { checkKnowledgeBase, type KnowledgeRuntime } from "./runtime";

export { knowledgeOperationName } from "./operations";

/** What the Knowledge Bases of one process are made of, for the assembly to put in place. */
export interface KnowledgeBases {
  /**
   * The kind `knowledge_base`: a definition that describes tables of its backend, with a draft
   * and a published revision. A workspace or the instance owns one.
   */
  readonly assetKind: RegisteredAssetKind<typeof KNOWLEDGE_BASE_ASSET_KIND>;
  /**
   * What a publish does beside moving the published pointer, with `stores` bound to the
   * transaction of the publish: the publisher must be let to hand the backend's rows on, every
   * described table must be readable, and then the Knowledge Base is let to read those tables
   * and no others, `replaced` being the revision published before. A throw refuses the publish.
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
   * What deleting the asset does: its last check goes, and its access to the backend with the
   * role it read as. No table and no row of the backend is touched.
   */
  retire(stores: PlatformStores, assetId: string, published: unknown): Promise<void>;
  readonly operationSource: OperationSource;
  /** Describes the one knowledge tool to an agent that lists Knowledge Bases. */
  readonly toolSource: DataToolSource;
}

export function createKnowledgeBases(input: {
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  /** Where the described tables are read. */
  backend: KnowledgeBackend;
  logger: Logger;
  now?: () => Date;
}): KnowledgeBases {
  const runtime: KnowledgeRuntime = {
    clientInstanceId: input.clientInstanceId,
    stores: input.stores,
    backend: input.backend,
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
      owners: ["instance", "workspace"],
      validate: () => [],
      summarize: (knowledgeBase) => ({
        name: knowledgeBase.name,
        title: knowledgeBase.title,
        description: knowledgeBase.description
      })
    }),
    async publish(stores, { access, assetId, revision, config, replaced }) {
      const definition = knowledgeBaseDefinitionSchema.parse(config);
      const target = knowledgeTargetOf(definition, assetId);
      await runtime.backend.requirePublishRight(target, access);
      const state = await checkKnowledgeBase(runtime, stores, { assetId, revision, definition });
      if (state.status === "ok") {
        const before = knowledgeBaseDefinitionSchema.safeParse(replaced);
        await runtime.backend.grant(
          stores,
          target,
          before.success ? knowledgeTargetOf(before.data, assetId) : undefined
        );
        return;
      }
      const missing = state.tables.filter((table) => !table.readable).map((table) => table.name);
      throw new AppError(
        "VALIDATION_FAILED",
        state.problem ??
          `The Knowledge Base cannot read ${missing.length === 1 ? "the table" : "the tables"} ${missing.map((name) => `'${name}'`).join(", ")} of the Data Store '${definition.backend.dataStore}'. Describe tables the store has, or publish the store's migration that makes them.`,
        { reason: "knowledge_base_needs_attention", tables: missing },
        { exposeMessage: true }
      );
    },
    async retire(stores, assetId, published) {
      await stores.knowledgeBases.deleteKnowledgeBaseState({
        clientInstanceId: input.clientInstanceId,
        assetId
      });
      const definition = knowledgeBaseDefinitionSchema.safeParse(published);
      // A Knowledge Base never published was never let to read anything.
      if (definition.success) {
        await runtime.backend.retire(stores, knowledgeTargetOf(definition.data, assetId));
      }
    },
    operationSource: createKnowledgeOperationSource(runtime),
    toolSource: createKnowledgeToolSource(runtime)
  };
}
