import {
  AppError,
  addDays,
  asCollaborationWorkspaceId,
  auditActorFromIdentity,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type ActorAccess,
  type AuthenticatedIdentity,
  type Conversation
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "./conversation-service";
import { AssetWorkflow } from "../assets/asset-service";
const PROPOSED_KIND = "agent";
import type { AssetCall } from "../assets/asset-access";
import { deleteTryConversations } from "../deletion/conversation-cleanup";
import type { ChatServerOptions } from "../types";

/** The agent alone identifies a person's Try conversation. */
interface TryAddress {
  name: string;
  workspaceId?: string;
}

const unavailable = () => new AppError("NOT_FOUND", "Conversation is not available");

export class TryConversations {
  private readonly options: ChatServerOptions;

  constructor(options: ChatServerOptions) {
    this.options = options;
  }

  async authorize(actor: AuthenticatedIdentity, access: ActorAccess, input: TryAddress) {
    if (isAuthenticatedServicePrincipal(actor)) throw unavailable();
    const agent = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: "agent",
      name: input.name
    });
    if (agent?.status !== "active") throw unavailable();
    const workspaceId = agent.scope.kind === "workspace" ? agent.scope.workspaceId : undefined;
    if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) throw unavailable();
    return new AssetWorkflow(this.options).authorizeWrite(access, {
      kind: "agent",
      name: input.name,
      ...(workspaceId ? { workspaceId } : {})
    });
  }

  /** Opens the person's private preview independently of any Build conversation. */
  async open(call: AssetCall, input: TryAddress): Promise<Conversation> {
    const { actor } = call;
    if (isAuthenticatedServicePrincipal(actor)) throw unavailable();
    const agent = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: PROPOSED_KIND,
      name: input.name,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
    });
    if (agent?.status !== "active") {
      throw new AppError(
        "NOT_FOUND",
        "The agent is not available",
        { reason: "agent_unavailable" },
        { exposeMessage: true }
      );
    }
    const workspace = await new ConversationWorkflow(this.options).resolveTargetWorkspace(
      actor,
      agent.scope.kind === "workspace"
        ? asCollaborationWorkspaceId(agent.scope.workspaceId)
        : undefined
    );
    const { conversation, created } = await this.options.stores.agentTryConversations.open({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      agentId: agent.id,
      createdByUserId: getSubjectUserId(actor),
      createdByExternalUserId: actor.externalUserId,
      title: `Try ${agent.name}`,
      retainedUntil: addDays(
        new Date(),
        this.options.config.retention.conversationDays
      ).toISOString()
    });
    if (created) {
      await this.options.auditRecorder.record({
        type: "conversation.created",
        status: "success",
        actor: auditActorFromIdentity(actor),
        subject: conversation.id,
        correlationId: call.correlationId,
        metadata: {
          retainedUntil: conversation.retainedUntil,
          preview: true,
          agentId: agent.id
        }
      });
    }
    return conversation;
  }

  /** All Try conversations of the agent go after Publish or Discard. */
  async settled(
    call: AssetCall,
    address: { name: string; workspaceId?: string },
    outcome: "published" | "discarded"
  ) {
    const agent = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: "agent",
      ...address
    });
    if (!agent) return;
    await deleteTryConversations(
      this.options,
      { agentId: agent.id },
      {
        deletedAt: new Date().toISOString(),
        requestedBy: outcome === "published" ? "draft_published" : "draft_discarded",
        correlationId: call.correlationId,
        actor: auditActorFromIdentity(call.actor)
      }
    );
  }
}
