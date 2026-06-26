import type { ActiveRunSummary, AgentRunProjection } from "./agent-runtime";
import type { AgentRunId, ClientInstanceId, ConversationId, MessageId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

export type ConversationStatus = "active" | "deleted" | "retention_expired";

export interface Conversation {
  id: ConversationId;
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  ownerExternalUserId: string;
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
  activeRun?: {
    run: ActiveRunSummary;
    projection: AgentRunProjection;
  };
  userState: ConversationUserState;
  serverTime: ISODateString;
}

export interface CreateConversationInput {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  ownerExternalUserId: string;
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

export interface UpdateConversationTitleInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  title: string;
  updatedAt: ISODateString;
}

export interface ConversationStore {
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  getConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId
  ): Promise<Conversation | undefined>;
  listConversationsForUser(input: {
    clientInstanceId: ClientInstanceId;
    ownerUserId: string;
  }): Promise<Conversation[]>;
  updateConversationTitle(input: UpdateConversationTitleInput): Promise<Conversation>;
  appendMessage(input: CreateMessageInput): Promise<ChatMessage>;
  listMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ChatMessage[]>;
  listRecentMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    limit: number;
  }): Promise<ChatMessage[]>;
  deleteConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: ISODateString;
  }): Promise<Conversation>;
}

export interface ConversationRetentionStore {
  listExpiredConversations(input: {
    clientInstanceId: ClientInstanceId;
    now: ISODateString;
    limit: number;
  }): Promise<Conversation[]>;
  expireConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    expiredAt: ISODateString;
  }): Promise<Conversation>;
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
}
