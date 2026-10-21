import {
  createAuthorizer,
  isAppError,
  KNOWLEDGE_BASE_ACTIONS,
  type ClientInstanceId,
  type KnowledgeFiles,
  type KnowledgeHitDocuments,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { KnowledgeBases } from "@work-shape/catalyst-data-stores";
import { requireConversationAccess } from "@work-shape/catalyst-server";

/**
 * What the document tools read on a search hit's file id (KB-7c). The person needs
 * `knowledge_base.use` on the hit's Knowledge Base in the workspace of the conversation the
 * agent answers in, as they need it to open the cited file there. Every refusal reads as a
 * file that is not there.
 */
export function createKnowledgeHitDocuments(input: {
  knowledgeBases: KnowledgeBases;
  files: KnowledgeFiles | undefined;
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
}): KnowledgeHitDocuments {
  const { clientInstanceId, stores } = input;
  return {
    async open({ user, conversationId, fileId, signal }) {
      let workspaceId: string;
      try {
        ({ collaborationWorkspaceId: workspaceId } = await requireConversationAccess(
          { stores, clientInstanceId },
          conversationId,
          user
        ));
      } catch (error) {
        if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
        throw error;
      }
      const found = await input.knowledgeBases.hitDocument(input.files, fileId, signal);
      if (!found) return undefined;
      const access = await createAuthorizer(stores.access).forActor(user, { workspaceId });
      return access.authorize(KNOWLEDGE_BASE_ACTIONS.use, found.resource).allowed
        ? found.document
        : undefined;
    }
  };
}
