import {
  CHAT_MESSAGE_ROLES,
  CONFIG_ASSET_KINDS,
  CONVERSATION_KINDS,
  CONVERSATION_VISIBILITIES
} from "@work-shape/catalyst-asset-schemas";
import type { ActiveRunSummary, AgentRunProjection } from "./agent-runtime";
import type { SkillResourceConfig } from "./config";
import type { AgentRunWriteFence, AuthenticatedUser } from "./identity";
import type {
  AgentRunId,
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  MessageId,
  UserId
} from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";

export type ConversationStatus = "active" | "deleted" | "retention_expired";

/**
 * A `chat` conversation is one a person has. A `run_thread` holds the transcript of a Child
 * Agent Run: a subagent's thread belongs to its root conversation and is read through it.
 */
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** `private` restricts a Conversation in a Shared Workspace to the user who created it. */
export type ConversationVisibility = (typeof CONVERSATION_VISIBILITIES)[number];

/**
 * Who a workspace Conversation listing is for. `viewer` hides other users' private
 * Conversations and Conversations without messages, except the viewer's own while they still
 * hold draft attachments; `author` lists only the user's own private ones, for a holder of a
 * bundle who is no member; `lifecycle` is for retention and deletion workflows that
 * must see every row.
 */
export type ConversationListScope =
  { kind: "viewer" | "author"; userId: string } | { kind: "lifecycle" };

/**
 * The asset a conversation is about, by its kind and its name, such as a Workflow whose draft
 * the agent edits. It is set when the conversation is created from the asset's page, and by
 * the server when the agent opens another asset of the conversation's workspace in it with
 * `platform.assets.open`: one subject at a time, the last one opened wins. An asset of the
 * instance becomes the subject only by the person's step, never by the agent's open. The tools
 * that check and save a draft reach this asset and no other, whatever a model names.
 */
export interface ConversationSubject {
  kind: string;
  name: string;
}

/**
 * What the conversations of an instance are offered beyond what their agent's definition
 * lists. An agent whose definition lists the platform's tools gets those it lists, the
 * orientation on the platform and the skills the platform ships for it; every other agent gets
 * none of them. Where Pages exist, every agent gets what builds one.
 */
export interface ConversationOffer {
  /**
   * The asset the conversation is about when the run starts: what its agent is told before
   * the first turn. Missing on a conversation about none yet.
   */
  subject?: ConversationSubject;
  toolNames: readonly string[];
  /**
   * The skills that ship with the platform and are offered here, by name. They are stored
   * skills like any other and read from the store: a skill a release no longer ships is
   * offered nowhere.
   */
  skillNames: readonly string[];
  /**
   * How the platform works, as a section of the system prompt. Only an agent that holds the
   * platform's tools is told it.
   */
  orientation?: string;
  /**
   * Tools the agent's definition lists that the person of the run may not call, such as
   * `mail.send` without `mail_sender.use` on its sender: they are not offered to the model.
   * Each call is still decided on its own.
   */
  withheldToolNames?: readonly string[];
}

/** The release skill containing this instance's product documentation. */
export const PLATFORM_DOCS_SKILL_NAME = "platform-docs";

/**
 * A skill that ships with the platform's code. When the API process starts, the release seed
 * stores it as a read-only skill of origin `release`, and a later release replaces it.
 */
export interface ShippedSkill {
  name: string;
  title: string;
  description: string;
  content: string;
  /** The files under the skill's folder, such as `references/<page>.md`, read through `read_skill`. */
  resources?: readonly SkillResourceConfig[];
  /** The key of the interface's icon registry that marks the skill in lists. */
  icon: string;
  /** The sentence for people that completes "Knows how to". */
  summary?: string;
  /**
   * The tools the skill has the agent call. It ships only where the instance has every one of
   * them, so the switch of the module or the setting that owns them decides it; without a list
   * it ships everywhere.
   */
  tools?: readonly string[];
}

export interface ConversationOfferSource {
  /** Nothing where the conversation is gone. */
  offerOf(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    /** The tools the agent's own definition lists: they decide whether it holds the platform's. */
    agentToolNames: readonly string[];
    /** The person the run acts for; the tools they may not call are withheld. */
    user?: AuthenticatedUser;
  }): Promise<ConversationOffer | undefined>;
}

/**
 * The prefix of the tools on the platform's assets. The server offers them to an agent whose
 * definition lists them. Only `platform.assets.open` moves what the
 * conversation is about; the check and the save reach that asset and no other.
 */
export const SUBJECT_TOOL_PREFIX = "platform.assets.";

/**
 * Where the assets a conversation's first saves create belong, where it is not the rule of
 * WS-OWN-1a: `instance` for a conversation started under Studio's scope "Instance". Set only
 * when the conversation is created, and never changed (studio-chat-entry.md, section 4a).
 */
export type ConversationCreationTarget = "instance";

/**
 * The kinds a conversation with the target `instance` creates for the instance. Every other
 * kind, such as a Data Store or a Workflow, keeps the rule of its owners.
 */
export const INSTANCE_TARGET_KINDS: readonly string[] = [...CONFIG_ASSET_KINDS, "guardrail"];

export interface Conversation {
  id: ConversationId;
  clientInstanceId: ClientInstanceId;
  kind: ConversationKind;
  /** Of a subagent's run thread: the chat conversation it belongs to. */
  parentConversationId?: ConversationId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  createdByUserId: string;
  createdByExternalUserId: string;
  visibility: ConversationVisibility;
  /** First personal call; permanent even when that call fails. */
  personalDataAt?: ISODateString;
  title: string;
  status: ConversationStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  retainedUntil: ISODateString;
  deletedAt?: ISODateString;
  /** The asset the conversation is about. Missing on a conversation about none. */
  subject?: ConversationSubject;
  /** Where its first saves create an agent, skill or guardrail. Missing: the workspace's rule. */
  creationTarget?: ConversationCreationTarget;
}

export interface ConversationListItem extends Conversation {
  latestMessageAt?: ISODateString;
  activeRun?: ActiveRunSummary;
  unread?: boolean;
  lastViewedAt?: ISODateString;
}

export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

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
  /** Effective root personal-data restriction; absent on older servers. */
  personalData?: boolean;
  followUps?: import("./follow-ups").ConversationFollowUp[];
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
  creationTarget?: ConversationCreationTarget;
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
  /** Where the conversation's history starts for this provider: kept after a compaction. */
  providerContinuation?: {
    providerId: string;
    state: JsonValue;
  };
  /** The continuation the run ended with, given with its last message: see `ModelProviderTurnContinuation`. */
  turnContinuation?: {
    providerId: string;
    model: string;
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

/**
 * An asset the agent of a conversation created (BUILD-ALL-1): the conversation may keep saving
 * its draft beside its subject. `revision` is the revision the create wrote.
 */
export interface ConversationCreatedAssetInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  assetId: string;
  revision: number;
  createdAt: ISODateString;
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
  /** Locks and rechecks owner-only readership before marking. Never clears or replaces the mark. */
  markPersonalData(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    userId: string;
    at: ISODateString;
  }): Promise<void>;
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
  /** Notes that the conversation created the asset. A second note of it changes nothing. */
  recordCreatedAsset(input: ConversationCreatedAssetInput): Promise<void>;
  /**
   * Whether the conversation created the active asset of `kind` and `name`, and nobody deleted
   * it or created it anew since: an asset made again under the name is another one.
   */
  createdAsset(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    kind: string;
    name: string;
  }): Promise<boolean>;
  /**
   * Deletes an active Conversation. With `inCollaborationWorkspaceId` only while it is in
   * that workspace: one that was moved away meanwhile is answered as not available.
   */
  deleteConversation(input: {
    /** Discard only this person's unused draft; refuse when it has any content. */
    discardEmptyByUserId?: UserId;
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
    /** A transcript copy for other readers: atomically refuse personal data before reading. */
    forSharing?: true;
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

/**
 * The provider continuation the last finished run of a conversation ended with, on one provider
 * and model: opaque, such as the encrypted reasoning of its steps. The next run on the same model
 * starts from it, so its request repeats the last one's and the provider's prompt cache holds.
 * Stored with the run's last message and gone with it or the conversation.
 */
export interface ModelProviderTurnContinuation {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  providerId: string;
  model: string;
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
  getModelProviderTurnContinuation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    providerId: string;
  }): Promise<ModelProviderTurnContinuation | undefined>;
  /**
   * Drops the continuations a provider cannot accept, the checkpoint and the turn's; the
   * conversation goes on from its history. With `keepCheckpoint` only the turn's goes: the
   * conversation goes on from its compaction checkpoint.
   */
  deleteModelProviderContinuation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    providerId: string;
    keepCheckpoint?: boolean;
    /** Given when an Agent Run drops it: refused once the run lost its lease. */
    runFence?: AgentRunWriteFence;
  }): Promise<void>;
}
