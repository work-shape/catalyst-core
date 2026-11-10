import {
  asCollaborationWorkspaceId,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  personalConnectionContextError,
  rootConversationOf,
  type OperationExecutionContext,
  type OperationResource
} from "@work-shape/catalyst-core";
import type { KnowledgeRuntime } from "./runtime";

/**
 * A read of a person's own Knowledge Base, one of their Personal Workspace, carries their data
 * into the chat an agent reads it in: the chat is marked before anything is read, under the
 * conversation's lock and the rule that only that person reads it, as a read of their own
 * skill marks it. Where it cannot be marked the read fails, and nothing is answered. A chat is
 * marked at its root; a Workflow's thread, which no person reads as a chat, and a call from
 * outside an agent run mark nothing.
 */
export async function markPersonalKnowledgeRead(
  runtime: Pick<KnowledgeRuntime, "clientInstanceId" | "stores">,
  resource: OperationResource,
  context: Pick<OperationExecutionContext, "actor" | "origin">
): Promise<void> {
  const { origin, actor } = context;
  if (origin.kind !== "agent" || resource.workspaceId === undefined) return;
  const { clientInstanceId, stores } = runtime;
  const owner = await stores.workspaces.getWorkspace(
    clientInstanceId,
    asCollaborationWorkspaceId(resource.workspaceId)
  );
  if (owner?.kind !== "personal") return;
  const root = await rootConversationOf(stores, clientInstanceId, origin.conversationId);
  if (!root) return;
  if (isAuthenticatedServicePrincipal(actor)) {
    throw personalConnectionContextError("only the acting person may read the root conversation");
  }
  await stores.conversations.markPersonalData({
    clientInstanceId,
    conversationId: root.id,
    userId: getSubjectUserId(actor),
    at: new Date().toISOString()
  });
}
