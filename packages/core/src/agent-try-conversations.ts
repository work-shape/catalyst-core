import type { Conversation, ConversationSubject } from "./conversation";
import type { ClientInstanceId, ConversationId } from "./ids";
import type { ISODateString } from "./time";

// The Try conversation of an agent page (TRY-1b; navigation-and-layout.md 4.7c): a conversation
// of its own, linked to one Build conversation and one agent, in which the person tries the
// agent under construction. No list shows it, its model usage is marked `preview`, and it is
// deleted when the person applies or discards the proposal and with its Build conversation.
// Its audit and usage events stay.

interface TryConversationsOf {
  clientInstanceId: ClientInstanceId;
  buildConversationId: ConversationId;
}

export interface AgentTryConversationStore {
  /**
   * The Try conversation of the Build conversation and the agent, made where there is none.
   * Under the Build conversation's row lock, so of two opens one makes it and the other finds
   * it, and a deletion of the Build conversation sees it. One that was deleted is replaced by a
   * new one, and its link stays until its cleanup is through. It is made private to its creator,
   * in the Build conversation's workspace. Refused as not available where the Build
   * conversation is not active, is not about the agent, or is a Try conversation.
   */
  open(
    input: TryConversationsOf & {
      /** The agent, by the id of its asset. */
      agentId: string;
      /** The agent as the subject its Build conversation is about. */
      agent: ConversationSubject;
      createdByUserId: string;
      createdByExternalUserId: string;
      title: string;
      retainedUntil: ISODateString;
    }
  ): Promise<{ conversation: Conversation; created: boolean }>;
  /**
   * The Try conversations of a Build conversation, replaced ones among them; with `agentId`,
   * those of that agent.
   */
  list(input: TryConversationsOf & { agentId?: string }): Promise<ConversationId[]>;
  /** Removes the link of a Try conversation once its data is cleaned up. */
  remove(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<void>;
}
