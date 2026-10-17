import {
  AppError,
  addDays,
  asConversationId,
  auditActorFromIdentity,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type Conversation
} from "@work-shape/catalyst-core";
import { PROPOSED_KIND, type ProposalSettled } from "../assets/agent-proposals";
import type { AssetCall } from "../assets/asset-access";
import { deleteTryConversations } from "../deletion/conversation-cleanup";
import type { ChatServerOptions } from "../types";

// The Try conversation of an agent page (TRY-1b; navigation-and-layout.md 4.7c). Beside the
// Build conversation, in which the agent proposes changes to an agent, the person tries the
// agent in a conversation of its own. No list shows it and its usage is marked `preview`, both
// by its link in the store. It goes when the person applies or discards the proposal, and with
// its Build conversation; its audit and usage events stay. Who may open it is who may decide
// on the proposal: the write right on the agent.

/** The agent and the person's own Build conversation a call names. */
interface TryAddress {
  name: string;
  conversationId: string;
}

const unavailable = () => new AppError("NOT_FOUND", "Conversation is not available");

export class TryConversations {
  private readonly options: ChatServerOptions;

  constructor(options: ChatServerOptions) {
    this.options = options;
  }

  /**
   * The Try conversation of the agent beside the Build conversation, made where there is none:
   * a second open answers the same one. The caller's right was asked on the agent and their
   * own Build conversation.
   */
  async open(call: AssetCall, input: TryAddress): Promise<Conversation> {
    const { actor } = call;
    if (isAuthenticatedServicePrincipal(actor)) throw unavailable();
    const agent = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: PROPOSED_KIND,
      name: input.name
    });
    if (agent?.status !== "active") {
      throw new AppError(
        "NOT_FOUND",
        "The agent is not available",
        { reason: "agent_unavailable" },
        { exposeMessage: true }
      );
    }
    const { conversation, created } = await this.options.stores.agentTryConversations.open({
      clientInstanceId: this.options.clientInstanceId,
      buildConversationId: asConversationId(input.conversationId),
      agentId: agent.id,
      agent: { kind: PROPOSED_KIND, name: agent.name },
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
          buildConversationId: input.conversationId
        }
      });
    }
    return conversation;
  }

  /** The Try conversation of the agent goes once the person applied or discarded its proposal. */
  readonly settled: ProposalSettled = (call, { agentId, conversationId, outcome }) =>
    deleteTryConversations(
      this.options,
      { buildConversationId: conversationId, agentId },
      {
        deletedAt: new Date().toISOString(),
        requestedBy: outcome === "applied" ? "proposal_applied" : "proposal_discarded",
        correlationId: call.correlationId,
        actor: auditActorFromIdentity(call.actor)
      }
    );
}
