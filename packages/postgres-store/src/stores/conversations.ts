import {
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ConversationId,
  type ConversationRetentionStore,
  type ConversationStore,
  type AppendAssistantMessageInput,
  type CreateConversationInput,
  type ExpireConversationResult,
  type CreateMessageInput,
  type ModelProviderContinuationCheckpoint,
  type ModelProviderContinuationStore
} from "@vivd-catalyst/core";
import {
  appendAssistantMessage as appendPostgresAssistantMessage,
  appendMessage as appendPostgresMessage,
  createConversation as createPostgresConversation,
  deleteConversation as deletePostgresConversation,
  expireConversation as expirePostgresConversation,
  getConversation as getPostgresConversation,
  listConversationsForWorkspace as listPostgresConversationsForWorkspace,
  listPrivateConversationsCreatedByUser as listPostgresPrivateConversationsCreatedByUser,
  moveConversation as movePostgresConversation,
  listExpiredConversations as listPostgresExpiredConversations,
  listMessages as listPostgresMessages,
  listRecentMessages as listPostgresRecentMessages,
  updateConversationTitle as updatePostgresConversationTitle
} from "../postgres-conversation-operations";
import {
  deleteModelProviderContinuation as deletePostgresModelProviderContinuation,
  getModelProviderContinuation as getPostgresModelProviderContinuation
} from "../postgres-model-provider-continuation-operations";
import type { ConversationsStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresConversationsStore(db: PostgresConnection): ConversationsStore {
  return {
    async createConversation(input: CreateConversationInput): Promise<Conversation> {
      return createPostgresConversation(db, input);
    },
    async getConversation(
      clientInstanceId: ClientInstanceId,
      conversationId: ConversationId
    ): Promise<Conversation | undefined> {
      return getPostgresConversation(db, clientInstanceId, conversationId);
    },
    async listConversationsForWorkspace(
      input: Parameters<ConversationStore["listConversationsForWorkspace"]>[0]
    ): Promise<Conversation[]> {
      return listPostgresConversationsForWorkspace(db, input);
    },
    async listPrivateConversationsCreatedByUser(
      input: Parameters<ConversationStore["listPrivateConversationsCreatedByUser"]>[0]
    ): Promise<Conversation[]> {
      return listPostgresPrivateConversationsCreatedByUser(db, input);
    },
    async moveConversation(
      input: Parameters<ConversationStore["moveConversation"]>[0]
    ): Promise<Conversation> {
      return movePostgresConversation(db, input);
    },
    async listExpiredConversations(input: {
      clientInstanceId: ClientInstanceId;
      now?: string;
      abandonedBefore?: string;
      limit: number;
    }): Promise<Conversation[]> {
      return listPostgresExpiredConversations(db, input);
    },
    async updateConversationTitle(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      title: string;
      updatedAt: string;
    }): Promise<Conversation> {
      return updatePostgresConversationTitle(db, input);
    },
    async appendMessage(input: CreateMessageInput): Promise<ChatMessage> {
      return appendPostgresMessage(db, input);
    },
    async appendAssistantMessage(input: AppendAssistantMessageInput): Promise<ChatMessage> {
      return appendPostgresAssistantMessage(db, input);
    },
    async listMessages(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
    }): Promise<ChatMessage[]> {
      return listPostgresMessages(db, input);
    },
    async listRecentMessages(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      limit: number;
    }): Promise<ChatMessage[]> {
      return listPostgresRecentMessages(db, input);
    },
    async getModelProviderContinuation(
      input: Parameters<ModelProviderContinuationStore["getModelProviderContinuation"]>[0]
    ): Promise<ModelProviderContinuationCheckpoint | undefined> {
      return getPostgresModelProviderContinuation(db, input);
    },
    async deleteModelProviderContinuation(
      input: Parameters<ModelProviderContinuationStore["deleteModelProviderContinuation"]>[0]
    ): Promise<void> {
      return deletePostgresModelProviderContinuation(db, input);
    },
    async deleteConversation(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      deletedAt: string;
    }): Promise<Conversation> {
      return deletePostgresConversation(db, input);
    },
    async expireConversation(
      input: Parameters<ConversationRetentionStore["expireConversation"]>[0]
    ): Promise<ExpireConversationResult> {
      return expirePostgresConversation(db, input);
    }
  };
}
