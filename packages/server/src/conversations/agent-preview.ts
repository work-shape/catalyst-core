import { agentConfigSchema, skillConfigSchema } from "@work-shape/catalyst-config-schema";
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
  const config = agentConfigSchema.parse(draft?.config ?? live.config);
  const skills = await skillDraftsForTry(options, caller, config.skillNames);
  return {
    agentId: live.id,
    revision: draft?.revision ?? live.revision,
    source: draft ? "draft" : "live",
    config,
    ...(skills.length > 0 ? { skills } : {})
  };
}

/**
 * The shared drafts of the skills an agent in Try lists that the person trying it may write
 * (SKILL-DRAFT-1): Try reads each of them in place of its live revision. Everyone else, and
 * every live run, reads the live skill. A draft the schema refuses is left out and read live.
 */
async function skillDraftsForTry(
  options: ChatServerOptions,
  access: ActorAccess,
  skillNames: readonly string[]
): Promise<NonNullable<AgentPreview["skills"]>> {
  const workflow = new AssetWorkflow(options);
  const found = await Promise.all(
    [...new Set(skillNames)].map(async (name) => {
      const skill = await options.configAssets.store.getConfigAsset({
        clientInstanceId: options.clientInstanceId,
        kind: "skill",
        name
      });
      if (skill?.status !== "active") return [];
      const right = await workflow.authorizeWrite(access, {
        kind: "skill",
        name,
        ...(skill.scope.kind === "workspace" ? { workspaceId: skill.scope.workspaceId } : {})
      });
      if (!right.allowed) return [];
      const draft = await options.stores.agentProposals.get({
        clientInstanceId: options.clientInstanceId,
        agentId: skill.id
      });
      const parsed = draft ? skillConfigSchema.safeParse(draft.config) : undefined;
      return draft && parsed?.success ? [{ revision: draft.revision, config: parsed.data }] : [];
    })
  );
  return found.flat();
}
