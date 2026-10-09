import type { StorePage } from "./paging";
import type { ActiveRunSummary, AgentRunProjection } from "./agent-runtime";
import type {
  AgentRunId,
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  MessageId
} from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { ISODateString } from "./time";

export type ConversationStatus = "active" | "deleted" | "retention_expired";

/** `private` restricts a Conversation in a Shared Workspace to the user who created it. */
export type ConversationVisibility = "workspace" | "private";

/**
 * Who a workspace Conversation listing is for. `viewer` hides other users' private
 * Conversations and Conversations without messages, except the viewer's own while they still
 * hold draft attachments; `lifecycle` is for retention and deletion workflows that must see
 * every row.
 */
export type ConversationListScope = { kind: "viewer"; userId: string } | { kind: "lifecycle" };

export interface Conversation {
  id: ConversationId;
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  createdByUserId: string;
  createdByExternalUserId: string;
  visibility: ConversationVisibility;
  title: string;
  status: ConversationStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  retainedUntil: ISODateString;
  deletedAt?: ISODateString;
}

export interface ConversationListItem extends Conversation {
  latestMessageAt?: ISODateString;
  activeRun?: ActiveRunSummary;
  unread?: boolean;
  lastViewedAt?: ISODateString;
}

export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: MessageId;
  conversationId: ConversationId;
  clientInstanceId: ClientInstanceId;
  role: ChatMessageRole;
  text: string;
  createdAt: ISODateString;
  metadata?: JsonObject;
}

export interface ConversationUserState {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  userId: string;
  lastViewedAt?: ISODateString;
  lastReadMessageId?: MessageId;
  lastReadRunId?: AgentRunId;
  lastReadRunSequence?: number;
  updatedAt: ISODateString;
}

export interface ConversationThreadSnapshot {
  conversation: Conversation;
  messages: ChatMessage[];
  completedRunProjections?: Record<string, AgentRunProjection>;
  activeRun?: {
    run: ActiveRunSummary;
    projection: AgentRunProjection;
  };
  userState: ConversationUserState;
  serverTime: ISODateString;
}

export interface CreateConversationInput {
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  createdByUserId: string;
  createdByExternalUserId: string;
  visibility: ConversationVisibility;
  title: string;
  retainedUntil: ISODateString;
}

export interface CreateMessageInput {
  id?: MessageId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  role: ChatMessageRole;
  text: string;
  metadata?: JsonObject;
}

export interface AppendAssistantMessageInput {
  id?: MessageId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  text: string;
  metadata?: JsonObject;
  providerContinuation?: {
    providerId: string;
    state: JsonValue;
  };
}

export interface UpdateConversationTitleInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  title: string;
  updatedAt: ISODateString;
}

export interface MoveConversationInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  fromCollaborationWorkspaceId: CollaborationWorkspaceId;
  toCollaborationWorkspaceId: CollaborationWorkspaceId;
  visibility: ConversationVisibility;
}

export interface ConversationStore extends ConversationHistoryStore {
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  getConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId
  ): Promise<Conversation | undefined>;
  listConversationsForWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    scope: ConversationListScope;
    page?: StorePage;
  }): Promise<Conversation[]>;
  /** Lifecycle only: every active private Conversation the user created, in any workspace. */
  listPrivateConversationsCreatedByUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
  }): Promise<Conversation[]>;
  moveConversation(input: MoveConversationInput): Promise<Conversation>;
  updateConversationTitle(input: UpdateConversationTitleInput): Promise<Conversation>;
  deleteConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: ISODateString;
  }): Promise<Conversation>;
}

export type ConversationExpiryReason = "retention_due" | "abandoned_draft";

export type ExpireConversationResult =
  | { status: "expired"; conversation: Conversation; reason: ConversationExpiryReason }
  | { status: "not_expired" };

export interface ConversationRetentionStore {
  /**
   * Active Conversations to expire. With `now`, the ones whose retention is due. With
   * `abandonedBefore`, the ones that hold no messages and no draft attachments and were last
   * touched at or before that time. Each criterion applies only when given. A Conversation
   * with an agent run in progress is left for a later pass.
   */
  listExpiredConversations(input: {
    clientInstanceId: ClientInstanceId;
    now?: ISODateString;
    abandonedBefore?: ISODateString;
    limit: number;
  }): Promise<Conversation[]>;
  /**
   * Expires the Conversation only if it meets the criteria of `listExpiredConversations` at the
   * moment its row is locked. An earlier read is never trusted: a message or upload accepted in
   * between leaves the Conversation `not_expired` and nothing is deleted.
   */
  expireConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    expiredAt: ISODateString;
    now?: ISODateString;
    abandonedBefore?: ISODateString;
  }): Promise<ExpireConversationResult>;
}

export interface ConversationHistoryReader {
  listMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ChatMessage[]>;
  listRecentMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    limit: number;
  }): Promise<ChatMessage[]>;
}

export interface ConversationHistoryStore extends ConversationHistoryReader {
  appendMessage(input: CreateMessageInput): Promise<ChatMessage>;
  appendAssistantMessage(input: AppendAssistantMessageInput): Promise<ChatMessage>;
}

export interface ModelProviderContinuationCheckpoint {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  providerId: string;
  state: JsonValue;
  sourceMessageId: MessageId;
  updatedAt: ISODateString;
}

export interface ModelProviderContinuationStore {
  getModelProviderContinuation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    providerId: string;
  }): Promise<ModelProviderContinuationCheckpoint | undefined>;
}
