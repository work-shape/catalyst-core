import type { Conversation } from "./conversation";
import type { ClientInstanceId, CollaborationWorkspaceId, ConversationId } from "./ids";
import type { ISODateString } from "./time";

/** Private Try conversations belong to one agent and person, independently of Build. */
export interface AgentTryConversationStore {
  /** Opens the current conversation, serializing concurrent opens for this agent and person. */
  open(input: {
    clientInstanceId: ClientInstanceId;
    agentId: string;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    createdByUserId: string;
    createdByExternalUserId: string;
    title: string;
    retainedUntil: ISODateString;
  }): Promise<{ conversation: Conversation; created: boolean }>;
  /** All conversations of an agent, including replaced conversations awaiting cleanup. */
  list(input: { clientInstanceId: ClientInstanceId; agentId: string }): Promise<ConversationId[]>;
  /** The agent a Try conversation runs, absent for ordinary conversations. */
  get(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<{ agentId: string; agentName?: string } | undefined>;
  /** Removes the link last, once the conversation's data cleanup completes. */
  remove(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<void>;
}
