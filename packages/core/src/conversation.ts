import type { StorePage } from "./paging";
import type { ActiveRunSummary, AgentRunProjection } from "./agent-runtime";
import type {
  AgentRunId,
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  MessageId
} from "./ids";
import type { AgentRunWriteFence } from "./identity";
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

/**
 * The asset a conversation is about, by its kind and its name, such as a Workflow whose draft
 * the agent edits. It is set when the conversation is created from the asset's page, and by
 * the server when the agent's tool first reads or saves another asset in it: one subject at a
 * time, the last one wins. The tools that check and save a draft reach this asset and no
 * other, whatever a model names.
 */
export interface ConversationSubject {
  kind: string;
  name: string;
}

/**
 * What the conversations of an instance are offered beyond what their agent's definition
 * lists: the tools that read and save an asset, and the skills the platform ships for the
 * assets of its kinds.
 */
export interface ConversationOffer {
  /**
   * The asset the conversation is about when the run starts: what its agent is told before
   * the first turn. Missing on a conversation about none yet.
   */
  subject?: ConversationSubject;
  toolNames: readonly string[];
  skills: readonly ShippedSkill[];
}

/** A skill that ships with the platform's code. It is no asset and nobody edits it. */
export interface ShippedSkill {
  name: string;
  title: string;
  description: string;
  content: string;
}

export interface ConversationOfferSource {
  /** Nothing where the conversation is gone. */
  offerOf(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ConversationOffer | undefined>;
}

/**
 * The prefix of the tools that read and save an asset. The server offers them to the agent of
 * every conversation, whatever its definition lists.
 */
export const SUBJECT_TOOL_PREFIX = "platform.assets.";

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
  /** The asset the conversation is about. Missing on a conversation about none. */
  subject?: ConversationSubject;
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
  subject?: ConversationSubject;
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

export interface SetConversationSubjectInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  subject: ConversationSubject;
}

export interface ReplaceConversationTitleInput extends UpdateConversationTitleInput {
  /** The title the caller read. Another title by now means someone else wrote one. */
  expectedTitle: string;
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
    /** Keeps the conversations whose title contains this text, without regard to case. */
    titleQuery?: string;
    page?: StorePage;
  }): Promise<Conversation[]>;
  /**
   * The same page as `listConversationsForWorkspace`, each Conversation with the summary of
   * its active run, read in one statement.
   */
  listConversationsWithActiveRun(
    input: Parameters<ConversationStore["listConversationsForWorkspace"]>[0]
  ): Promise<ConversationListItem[]>;
  /** Lifecycle only: every active private Conversation the user created, in any workspace. */
  listPrivateConversationsCreatedByUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
  }): Promise<Conversation[]>;
  moveConversation(input: MoveConversationInput): Promise<Conversation>;
  updateConversationTitle(input: UpdateConversationTitleInput): Promise<Conversation>;
  /**
   * Writes the title only while the conversation still carries `expectedTitle`, in one
   * statement. False when it carries another title or is not active.
   */
  replaceConversationTitle(input: ReplaceConversationTitleInput): Promise<boolean>;
  /**
   * Makes `subject` what an active conversation is about, in place of what it was about.
   * Leaves its time of change alone: a subject is no message. Nothing when the conversation
   * is not active.
   */
  setConversationSubject(input: SetConversationSubjectInput): Promise<Conversation | undefined>;
  /**
   * Deletes an active Conversation. With `inCollaborationWorkspaceId` only while it is in
   * that workspace: one that was moved away meanwhile is answered as not available.
   */
  deleteConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: ISODateString;
    inCollaborationWorkspaceId?: CollaborationWorkspaceId;
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
  /** Drops a continuation the provider cannot accept; the conversation goes on from its history. */
  deleteModelProviderContinuation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    providerId: string;
    /** Given when an Agent Run drops it: refused once the run lost its lease. */
    runFence?: AgentRunWriteFence;
  }): Promise<void>;
}
