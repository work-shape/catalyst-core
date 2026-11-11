import {
  CONVERSATION_SHARE_REFUSALS,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  NOTICE_KIND,
  NOTICE_TEXT_MAX_LENGTH,
  NOTICE_TITLE_MAX_LENGTH,
  AppError,
  SHARE_SEARCHES_PER_MINUTE,
  SHARE_SEARCH_INSTANCE_MIN_CHARS,
  asUserId,
  auditActorFromUser,
  conversationShareRefusal,
  getSubjectUserId,
  isAppError,
  isPersonInOwnSession,
  personalConversationPrivateError,
  shareFirstPartyOnlyError,
  type AuditActor,
  type AuditRecorder,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type Conversation,
  type ConversationId,
  type ConversationPersonRemovedReason,
  type ConversationShareCandidate,
  type ConversationShareRefusal,
  type LocaleCode,
  type PlatformStores,
  type UserRecord
} from "@work-shape/catalyst-core";
import { accessResource } from "../assets/asset-access";
import { noticeContentSchema } from "../notices/notice-kind";
import type { ChatServerOptions, ResolvedChatServerOptions } from "../types";
import { requireChatConversationAccess } from "./conversation-access";
import { accessOf } from "./platform-asset-subject";

// Named people on one private chat (CHAT-SHARE-1, `chat-sharing.md`). The creator of a
// private chat in a Shared Workspace, outside any project, names active people of the
// instance; each reads and writes in it, and one who is no member of the workspace reaches
// nothing else of it (CHAT-SHARE-6, ADR-0034). Only the creator, in their own
// session, changes who reads it: no agent tool calls these, and a key, a delegated actor or
// an embedding host is refused. The store checks the share guard again under the chat's row
// lock, the lock the personal-data mark takes: whichever comes first wins.

const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

interface CallContext {
  correlationId: string;
}

type ShareOptions = ResolvedChatServerOptions;

export class ConversationPeopleWorkflow {
  constructor(private readonly options: ShareOptions) {}

  /**
   * Names `userId` on the creator's private chat. Refused, with a stable reason, where the
   * caller is not the creator in their own session, the person is not active on the instance,
   * or the share guard holds: the personal-data mark, a project, a Personal Workspace, or a
   * Data Store or subject the person holds no right on by their own rights. Naming a person
   * already named changes nothing. The person gets an Inbox notice; the audit row says
   * `outside` where they are no member of the chat's workspace (CHAT-SHARE-6).
   */
  async addPerson(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: CallContext,
    command: { userId: string }
  ): Promise<Conversation> {
    const conversation = await requireChatConversationAccess(this.options, conversationId, user);
    const audit = (
      status: "success" | "denied",
      reason?: ConversationShareRefusal,
      outside?: boolean
    ) =>
      this.options.auditRecorder.record({
        type: "conversation.person_added",
        status,
        actor: auditActorFromUser(user),
        subject: conversationId,
        correlationId: context.correlationId,
        metadata: {
          workspaceId: conversation.collaborationWorkspaceId,
          personId: command.userId,
          ...(outside ? { outside: true } : {}),
          ...(reason ? { reason } : {})
        }
      });
    let added: { added: boolean; outside: boolean; conversation: Conversation };
    let workspace: CollaborationWorkspace;
    let person: UserRecord;
    try {
      requireOwnSession(user);
      requireCreator(conversation, user);
      workspace = await this.requireShareable(conversation);
      person = await this.requireNameable(user, command.userId);
      const checked = await this.requirePersonReads(conversation, person);
      added = await this.options.stores.transaction(async (stores) => {
        const result = await stores.conversations.addConversationPerson({
          clientInstanceId: this.options.clientInstanceId,
          conversationId,
          userId: person.id,
          addedByUserId: getSubjectUserId(user),
          addedAt: new Date().toISOString(),
          checked
        });
        if (result.added) {
          await fileShareNotice(stores, this.options, {
            conversation: result.conversation,
            workspace,
            person,
            from: user,
            outside: result.outside
          });
        }
        return result;
      });
    } catch (error) {
      const reason = shareRefusalOf(error);
      if (reason) await audit("denied", reason);
      throw error;
    }
    if (added.added) await audit("success", undefined, added.outside);
    return added.conversation;
  }

  /**
   * Takes a named person off the chat: its creator removes anyone, a named person leaves. It
   * waits while a turn of that person goes, and drops their queued follow-ups.
   */
  async removePerson(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: CallContext,
    personId: string
  ): Promise<{ conversationId: string; userId: string; removed: boolean }> {
    const conversation = await requireChatConversationAccess(this.options, conversationId, user);
    requireOwnSession(user);
    const self = getSubjectUserId(user);
    const reason: ConversationPersonRemovedReason = personId === self ? "left" : "removed";
    if (reason === "removed") requireCreator(conversation, user);
    else if (conversation.createdByUserId === self) {
      // The creator does not leave their own chat: they delete it, or move it.
      throw conversationShareRefusal(
        "share_person_unavailable",
        "The person who started the chat does not leave it. Delete it, or remove the people",
        {},
        "CONFLICT"
      );
    }
    const removed = await this.options.stores.transaction(async (stores) => {
      const done = await stores.conversations.removeConversationPerson({
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        userId: personId
      });
      if (done) await dropFollowUps(stores, this.options, conversationId, personId);
      return done;
    });
    if (removed) {
      await recordPersonRemoved(this.options.auditRecorder, {
        actor: auditActorFromUser(user),
        conversationId,
        personId,
        reason,
        correlationId: context.correlationId
      });
    }
    return { conversationId, userId: personId, removed };
  }

  /**
   * The people the chat's creator may name: preselected, or searched. A search of two letters
   * or more spans the instance and is rate limited per person (CHAT-SHARE-6).
   */
  async shareCandidates(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    query: { query?: string; limit: number }
  ): Promise<{ candidates: ConversationShareCandidate[] }> {
    const conversation = await requireChatConversationAccess(this.options, conversationId, user);
    requireOwnSession(user);
    requireCreator(conversation, user);
    await this.requireShareable(conversation);
    await this.requireSearchWithinLimit(user, query.query);
    const candidates = await this.options.stores.conversations.listShareCandidates({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      collaborationWorkspaceId: conversation.collaborationWorkspaceId,
      creatorUserId: getSubjectUserId(user),
      ...(query.query === undefined ? {} : { query: query.query }),
      limit: query.limit
    });
    return { candidates };
  }

  /** 30 searches of the instance a minute per person, under the existing rate limiter. */
  private async requireSearchWithinLimit(
    user: AuthenticatedUser,
    query: string | undefined
  ): Promise<void> {
    const { config, rateLimiter } = this.options;
    if (!config.rateLimits.enabled) return;
    if ((query?.trim().length ?? 0) < SHARE_SEARCH_INSTANCE_MIN_CHARS) return;
    const decision = await rateLimiter.consume(`share-search:${getSubjectUserId(user)}`, {
      limit: SHARE_SEARCHES_PER_MINUTE,
      windowMs: 60_000
    });
    if (!decision.allowed) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many searches. Wait a moment.",
        {
          reason: "rate_limited",
          retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
        },
        { exposeMessage: true }
      );
    }
  }

  /** The share guard as far as the chat itself decides it; the store asks it again. */
  private async requireShareable(conversation: Conversation): Promise<CollaborationWorkspace> {
    if (conversation.personalDataAt) throw personalConversationPrivateError();
    if (conversation.projectId !== undefined) {
      throw conversationShareRefusal(
        "conversation_in_project",
        "This chat is in a project. Share the project instead",
        { projectId: conversation.projectId }
      );
    }
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      conversation.collaborationWorkspaceId
    );
    if (workspace?.kind !== "shared") {
      throw conversationShareRefusal(
        "personal_workspace_conversation",
        "A chat of a Personal Workspace stays its owner's. Move it to a team to share it"
      );
    }
    const preview = await this.options.stores.agentTryConversations.get({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: conversation.id
    });
    if (preview || conversation.kind !== "chat" || conversation.visibility !== "private") {
      throw conversationShareRefusal(
        "conversation_not_shareable",
        "Only a private chat in a team, outside any project, is shared with named people"
      );
    }
    return workspace;
  }

  /**
   * An active person of the instance, not the creator: member of the chat's workspace or not
   * (ADR-0034). A user record is a person; service principals and keys have none. The store
   * asks it again under the person's row.
   */
  private async requireNameable(user: AuthenticatedUser, userId: string): Promise<UserRecord> {
    const unavailable = () =>
      conversationShareRefusal(
        "share_person_unavailable",
        "Only an active person of the instance can be named"
      );
    if (userId === getSubjectUserId(user)) throw unavailable();
    const person = await this.options.stores.users.getUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(userId)
    });
    if (
      !person ||
      person.clientInstanceId !== this.options.clientInstanceId ||
      // "deleting" is a person whose deletion was requested.
      person.status !== "active"
    ) {
      throw unavailable();
    }
    return person;
  }

  /**
   * The person holds `data_store.read` on every Data Store the chat reads, and the write right
   * on the asset it is about, so they could read all of it anyway. Answers what was checked,
   * which the store compares under the lock.
   */
  private async requirePersonReads(
    conversation: Conversation,
    person: UserRecord
  ): Promise<{
    dataStoreAssetIds: string[];
    subject?: { kind: string; name: string };
  }> {
    const access = await accessOf(this.options, identityOf(person));
    const stores = await this.options.stores.conversations.listConversationDataStores({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: conversation.id
    });
    for (const store of stores) {
      const reads = access.authorize(
        DATA_STORE_ACTIONS.read,
        accessResource(DATA_STORE_ASSET_KIND, store.name, store.scope, store.assetId)
      ).allowed;
      if (!reads) {
        throw conversationShareRefusal(
          "data_store_conversation_private",
          `This chat reads the Data Store ${store.name}, which the person may not read`,
          { store: store.name }
        );
      }
    }
    const { subject } = conversation;
    if (subject) {
      const right = `${subject.kind}.write`;
      const asset = await this.options.configAssets.store.getConfigAsset({
        clientInstanceId: this.options.clientInstanceId,
        kind: subject.kind,
        name: subject.name
      });
      const writes =
        asset?.status === "active" &&
        access.authorize(right, accessResource(asset.kind, asset.name, asset.scope, asset.id))
          .allowed;
      if (!writes) {
        throw conversationShareRefusal(
          "subject_conversation_private",
          `This chat is about an asset whose draft only a holder of ${right} reads`,
          { right }
        );
      }
    }
    return {
      dataStoreAssetIds: stores.map((store) => store.assetId),
      ...(subject ? { subject: { kind: subject.kind, name: subject.name } } : {})
    };
  }
}

/**
 * Takes a person whose membership of a Shared Workspace ends off every chat of it that names
 * them, in the transaction that ends it, and drops their queued follow-ups there. Without a
 * workspace, off every chat: their account is being deleted. Answers the chats they lost.
 */
export async function removePersonFromWorkspaceChats(
  stores: PlatformStores,
  options: Pick<ChatServerOptions, "clientInstanceId">,
  input: { userId: string; collaborationWorkspaceId?: CollaborationWorkspaceId }
): Promise<ConversationId[]> {
  const lost = await stores.conversations.removePersonFromWorkspaceConversations({
    clientInstanceId: options.clientInstanceId,
    userId: input.userId,
    ...(input.collaborationWorkspaceId === undefined
      ? {}
      : { collaborationWorkspaceId: input.collaborationWorkspaceId })
  });
  for (const conversationId of lost) {
    await dropFollowUps(stores, options, conversationId, input.userId);
  }
  return lost;
}

/** Audits, by the system, that a person lost the chats their membership ended. */
export async function recordMembershipEndedChats(
  audit: AuditRecorder,
  input: { personId: string; conversationIds: readonly ConversationId[]; correlationId: string }
): Promise<void> {
  for (const conversationId of input.conversationIds) {
    await recordPersonRemoved(audit, {
      actor: SYSTEM_ACTOR,
      conversationId,
      personId: input.personId,
      reason: "membership_ended",
      correlationId: input.correlationId
    });
  }
}

export async function recordPersonRemoved(
  audit: AuditRecorder,
  input: {
    actor: AuditActor;
    conversationId: ConversationId;
    personId: string;
    reason: ConversationPersonRemovedReason;
    correlationId: string;
  }
): Promise<void> {
  await audit.record({
    type: "conversation.person_removed",
    status: "success",
    actor: input.actor,
    subject: input.conversationId,
    correlationId: input.correlationId,
    metadata: { personId: input.personId, reason: input.reason }
  });
}

/** Cancels the person's queued follow-ups in a chat they no longer read; their files go. */
async function dropFollowUps(
  stores: PlatformStores,
  options: Pick<ChatServerOptions, "clientInstanceId">,
  conversationId: ConversationId,
  userId: string
): Promise<void> {
  const pending = await stores.followUps.listPending({
    clientInstanceId: options.clientInstanceId,
    conversationId
  });
  for (const followUp of pending) {
    if (followUp.authorUserId !== userId) continue;
    try {
      await stores.followUps.cancel({
        clientInstanceId: options.clientInstanceId,
        conversationId,
        followUpId: followUp.id,
        authorUserId: userId
      });
    } catch (error) {
      // Sent or withdrawn meanwhile.
      if (!isAppError(error) || (error.code !== "NOT_FOUND" && error.code !== "CONFLICT")) {
        throw error;
      }
    }
  }
}

function requireOwnSession(user: AuthenticatedUser): void {
  if (!isPersonInOwnSession(user)) throw shareFirstPartyOnlyError();
}

function requireCreator(conversation: Conversation, user: AuthenticatedUser): void {
  if (conversation.createdByUserId !== getSubjectUserId(user)) {
    throw conversationShareRefusal(
      "share_creator_only",
      "Only the person who started the chat names who reads it",
      {},
      "FORBIDDEN"
    );
  }
}

/** The stable reason of a refusal of a share, for its audit row; nothing for another error. */
function shareRefusalOf(error: unknown): ConversationShareRefusal | undefined {
  if (!isAppError(error)) return undefined;
  const { details } = error;
  const reason =
    typeof details === "object" && details !== null && "reason" in details
      ? details.reason
      : undefined;
  return CONVERSATION_SHARE_REFUSALS.find((known) => known === reason);
}

/** The named person as the authorizer reads their rights: their own, without a key. */
function identityOf(person: UserRecord): AuthenticatedUser {
  const identity = person.identities[0];
  return {
    id: person.id,
    subjectUserId: person.id,
    externalUserId: identity?.externalUserId ?? person.id,
    authSource: identity?.authSource ?? "conversation-share",
    clientInstanceId: person.clientInstanceId,
    displayLabel: person.displayLabel,
    email: person.email,
    roles: person.roles,
    permissionRefs: person.permissionRefs,
    permissions: person.permissions
  };
}

/**
 * The Inbox notice to the person named, from the creator, in the person's language: the
 * chat's title, a link to it in its workspace. Inbox only: no mail is sent.
 */
async function fileShareNotice(
  stores: PlatformStores,
  options: ShareOptions,
  input: {
    conversation: Conversation;
    workspace: CollaborationWorkspace;
    person: UserRecord;
    from: AuthenticatedUser;
    outside: boolean;
  }
): Promise<void> {
  const locale = input.person.locale ?? options.config.localization.defaultLocale;
  const content = noticeContentSchema.parse({
    ...shareNoticeContent(locale, {
      from: input.from.displayLabel,
      title: input.conversation.title,
      workspace: input.workspace.name,
      outside: input.outside
    }),
    link: {
      kind: "conversation",
      workspaceId: input.conversation.collaborationWorkspaceId,
      conversationId: input.conversation.id
    }
  });
  await stores.approvals.createApprovalRequest({
    clientInstanceId: options.clientInstanceId,
    kind: NOTICE_KIND,
    summary: content.title,
    payload: content,
    requestedBy: { id: input.from.id, displayLabel: input.from.displayLabel },
    addresseeUserId: input.person.id
  });
}

function shareNoticeContent(
  locale: LocaleCode,
  input: { from: string; title: string; workspace: string; outside: boolean }
): { title: string; text: string } {
  const german = locale.toLowerCase().startsWith("de");
  const from = oneLine(input.from);
  const chat = oneLine(input.title);
  const workspace = oneLine(input.workspace);
  const title = german
    ? `${from} hat „${chat}“ mit dir geteilt`
    : `${from} shared “${chat}” with you`;
  // One outside the workspace reads this chat and nothing else of it (CHAT-SHARE-6).
  const text = input.outside
    ? german
      ? `Du kannst den ganzen Chat lesen und darin schreiben. Von ${workspace} siehst du sonst nichts.`
      : `You can read the whole chat and write in it. You see nothing else of ${workspace}.`
    : german
      ? `Du kannst den ganzen Chat lesen und darin schreiben, solange du Mitglied von ${workspace} bist.`
      : `You can read the whole chat and write in it while you are a member of ${workspace}.`;
  return { title: cut(title, NOTICE_TITLE_MAX_LENGTH), text: cut(text, NOTICE_TEXT_MAX_LENGTH) };
}

function oneLine(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
