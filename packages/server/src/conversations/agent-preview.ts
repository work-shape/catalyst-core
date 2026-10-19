import { agentConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  getSubjectUserId,
  type ActorAccess,
  type AuthenticatedUser,
  type Conversation,
  type AgentPreview
} from "@work-shape/catalyst-core";
import { AssetWorkflow } from "../assets/asset-service";
import type { ChatServerOptions } from "../types";

/** The stored preview link, never a request flag, decides which agent and revision may run. */
export async function previewForTurn(
  options: ChatServerOptions,
  conversation: Conversation,
  user: AuthenticatedUser,
  access: ActorAccess | undefined
): Promise<AgentPreview | undefined> {
  const preview = await options.stores.agentTryConversations.get({
    clientInstanceId: options.clientInstanceId,
    conversationId: conversation.id
  });
  if (!preview) return undefined;
  if (conversation.createdByUserId !== getSubjectUserId(user))
    throw new AppError("NOT_FOUND", "Conversation is not available");
  if (!preview.agentName) throw new AppError("NOT_FOUND", "The preview agent is not available");
  const live = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: "agent",
    name: preview.agentName
  });
  if (live?.status !== "active" || live.id !== preview.agentId)
    throw new AppError("NOT_FOUND", "The preview agent is not available");
  const caller = access ?? (await options.authorizer?.forActor(user));
  if (!caller) throw new AppError("INTERNAL", "Preview authorization is not available");
  const right = await new AssetWorkflow(options).authorizeWrite(caller, {
    kind: "agent",
    name: live.name,
    ...(live.scope.kind === "workspace" ? { workspaceId: live.scope.workspaceId } : {})
  });
  if (!right.allowed) throw new AppError("NOT_FOUND", "Conversation is not available");
  const draft = await options.stores.agentProposals.get({
    clientInstanceId: options.clientInstanceId,
    agentId: live.id
  });
  return {
    agentId: live.id,
    revision: draft?.revision ?? live.revision,
    source: draft ? "draft" : "live",
    config: agentConfigSchema.parse(draft?.config ?? live.config)
  };
}
