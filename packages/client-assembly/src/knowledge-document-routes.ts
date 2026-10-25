import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  asConversationId,
  createAuthorizer,
  isAuthenticatedServicePrincipal,
  type ClientInstanceId,
  type KnowledgeFiles,
  type AccessDecision,
  type OperationAuthorization,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { KnowledgeBases } from "@work-shape/catalyst-data-stores";
import { requireConversationAccess, type RouteRegistration } from "@work-shape/catalyst-server";

const USE = KNOWLEDGE_BASE_ACTIONS.use;

/**
 * Opens a cited original. The reader needs `knowledge_base.use` on the Knowledge Base. A
 * citation names the conversation it stands in: a reader who can open that conversation uses
 * the Knowledge Base in its workspace, so availability to that workspace counts, as it did for
 * the agent run that cited it. Without a conversation only the reader's own rights count.
 */
export function knowledgeDocumentRoutes(input: {
  knowledgeBases: KnowledgeBases;
  files: KnowledgeFiles | undefined;
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
}): RouteRegistration {
  const { clientInstanceId, stores } = input;
  return (routes) => {
    routes.operation(apiOperations["knowledge_bases.open_document"], {
      module: "knowledge",
      resource: ({ knowledgeBase }) => ({
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        id: knowledgeBase,
        name: knowledgeBase
      }),
      async authorize({ knowledgeBase, conversationId }, context) {
        // A conversation the reader cannot open lends no workspace: it is not available alike.
        const conversation =
          conversationId === undefined || isAuthenticatedServicePrincipal(context.actor)
            ? undefined
            : await requireConversationAccess(
                { stores, clientInstanceId },
                asConversationId(conversationId),
                context.actor
              );
        if (conversationId !== undefined && !conversation) {
          throw new AppError("NOT_FOUND", "Conversation is not available");
        }
        const access = conversation
          ? await createAuthorizer(stores.access).forActor(context.actor, {
              workspaceId: conversation.collaborationWorkspaceId
            })
          : context.access;
        const decision = access.authorize(USE, context.resource);
        if (decision.allowed && context.resource?.assetId === undefined) {
          // The shared resource resolver found no stored identity. Only a kind-level holder
          // may learn that this Knowledge Base does not exist.
          throw new AppError("NOT_FOUND", `Config knowledge_base '${knowledgeBase}' was not found`);
        }
        return decide(decision);
      },
      execute: ({ knowledgeBase, documentId }, context) =>
        input.knowledgeBases.openDocument(
          input.files,
          knowledgeBase,
          documentId,
          context.runtime.signal
        )
    });
    // KBW-2c: the delete question of a Workflow names what its delete ends. Only who may
    // delete it asks; a Knowledge Base the reader may not use is counted, never named.
    routes.operation(apiOperations["knowledge_bases.workflow_sources"], {
      module: "knowledge",
      resource: ({ workflow }) => ({ kind: WORKFLOW_ASSET_KIND, id: workflow, name: workflow }),
      authorize(_input, context) {
        const decision = context.access.authorize(WORKFLOW_ACTIONS.delete, context.resource);
        return decision.allowed
          ? { allowed: true }
          : { allowed: false, action: WORKFLOW_ACTIONS.delete, reason: decision.reason };
      },
      execute: ({ workflow }, context) =>
        input.knowledgeBases.workflowSources(workflow, context.access, context.runtime.signal)
    });
  };
}

function decide(decision: AccessDecision): OperationAuthorization {
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, action: USE, reason: decision.reason };
}
