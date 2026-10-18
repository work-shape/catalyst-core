import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  KNOWLEDGE_BASE_ACTIONS,
  type ClientInstanceId,
  type KnowledgeFiles,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { KnowledgeBases } from "@work-shape/catalyst-data-stores";
import type { RouteRegistration } from "@work-shape/catalyst-server";

export function knowledgeDocumentRoutes(input: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  knowledgeBases: KnowledgeBases;
  files: KnowledgeFiles | undefined;
}): RouteRegistration {
  return (routes) =>
    routes.operation(apiOperations["knowledge_bases.open_document"], {
      module: "knowledge",
      resource: ({ knowledgeBase }) => ({
        kind: "knowledge_base",
        id: knowledgeBase,
        name: knowledgeBase
      }),
      authorize: async ({ knowledgeBase }, { access }) => {
        const asset = await input.stores.configAssets.getConfigAsset({
          clientInstanceId: input.clientInstanceId,
          kind: "knowledge_base",
          name: knowledgeBase
        });
        const resource = {
          kind: "knowledge_base",
          name: knowledgeBase,
          ...(asset
            ? {
                assetId: asset.id,
                ...(asset.scope.kind === "workspace"
                  ? { workspaceId: asset.scope.workspaceId }
                  : {})
              }
            : {})
        };
        const decision = access.authorize(KNOWLEDGE_BASE_ACTIONS.use, resource);
        return decision.allowed
          ? { allowed: true }
          : { allowed: false, action: KNOWLEDGE_BASE_ACTIONS.use, reason: decision.reason };
      },
      execute: ({ knowledgeBase, documentId }, context) =>
        input.knowledgeBases.openDocument(
          input.files,
          knowledgeBase,
          documentId,
          context.runtime.signal
        )
    });
}
