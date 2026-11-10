import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQLWrapper
} from "drizzle-orm";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  AppError,
  CONVERSATION_PEOPLE_MAX,
  asConversationId,
  conversationHasPeopleError,
  conversationShareRefusal,
  personalConversationPrivateError,
  type AddConversationPersonInput,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type Conversation,
  type ConversationId,
  type ConversationShareCandidate
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { prefixPattern } from "./like-pattern";
import { lockActiveConversation } from "./postgres-conversation-lifecycle";
import { conversationFields } from "./postgres-conversation-fields";
import { mapConversation } from "./rows";
export { conversationFields } from "./postgres-conversation-fields";
import {
  agentRuns,
  collaborationWorkspaceMemberships,
  collaborationWorkspaces,
  conversationDataStores,
  conversationPeople,
  conversations,
  messages,
  productUsers
} from "./schema";

/**
 * Whether `userId` reads the conversation of the enclosing statement by its own audience: a
 * `workspace` one, their own, or a chat that names them. The SQL twin of the clause of
 * `requireConversationAccess`, beside the membership its callers ask.
 */
export function readsConversation(userId: string | SQLWrapper) {
  return or(
    sql`"conversations"."visibility" = 'workspace'`,
    sql`"conversations"."created_by_user_id" = ${userId}`,
    sql`exists (select 1 from conversation_people cp where cp.client_instance_id = "conversations"."client_instance_id" and cp.conversation_id = coalesce("conversations"."parent_conversation_id", "conversations"."id") and cp.user_id = ${userId})`
  );
}

/** Whether the conversation of the enclosing statement names nobody. */
export function namesNobody() {
  return sql`not exists (select 1 from conversation_people cp where cp.client_instance_id = "conversations"."client_instance_id" and cp.conversation_id = coalesce("conversations"."parent_conversation_id", "conversations"."id"))`;
}

async function readConversation(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
): Promise<Conversation | undefined> {
  const [row] = await tx
    .select(conversationFields)
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.id, conversationId)
      )
    )
    .limit(1);
  return row ? mapConversation(row) : undefined;
}

function notShareable(): AppError {
  return conversationShareRefusal(
    "conversation_not_shareable",
    "Only a private chat in a team, outside any project, is shared with named people"
  );
}

function checksChanged(): AppError {
  return conversationShareRefusal(
    "share_checks_changed",
    "The chat changed while the person was being added. Try again",
    {},
    "CONFLICT"
  );
}

export async function addConversationPerson(
  db: PostgresConnection,
  input: AddConversationPersonInput
): Promise<{ added: boolean; conversation: Conversation }> {
  return db.transaction(async (tx) => {
    const { clientInstanceId, conversationId } = input;
    // The row lock the personal-data mark takes too: whichever comes first wins (3.2).
    if (!(await lockActiveConversation(tx, clientInstanceId, conversationId))) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    const conversation = await readConversation(tx, clientInstanceId, conversationId);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation is not available");
    if (conversation.createdByUserId !== input.addedByUserId) {
      throw conversationShareRefusal(
        "share_creator_only",
        "Only the person who started the chat names who reads it",
        {},
        "FORBIDDEN"
      );
    }
    if (conversation.personalDataAt) throw personalConversationPrivateError();
    if (conversation.projectId !== undefined) {
      throw conversationShareRefusal(
        "conversation_in_project",
        "This chat is in a project. Share the project instead",
        { projectId: conversation.projectId }
      );
    }
    if (conversation.kind !== "chat" || conversation.visibility !== "private") {
      throw notShareable();
    }
    const [workspace] = await tx
      .select({ kind: collaborationWorkspaces.kind })
      .from(collaborationWorkspaces)
      .where(
        and(
          eq(collaborationWorkspaces.clientInstanceId, clientInstanceId),
          eq(collaborationWorkspaces.id, conversation.collaborationWorkspaceId)
        )
      );
    if (workspace?.kind !== "shared") {
      throw conversationShareRefusal(
        "personal_workspace_conversation",
        "A chat of a Personal Workspace stays its owner's. Move it to a team to share it"
      );
    }
    // What the person's rights were checked on is all the chat reads.
    const stores = await tx
      .select({ id: conversationDataStores.storeAssetId })
      .from(conversationDataStores)
      .where(
        and(
          eq(conversationDataStores.clientInstanceId, clientInstanceId),
          eq(conversationDataStores.conversationId, conversationId)
        )
      );
    const checkedStores = new Set(input.checked.dataStoreAssetIds);
    const subject = conversation.subject;
    if (
      stores.some((store) => !checkedStores.has(store.id)) ||
      (subject?.kind ?? null) !== (input.checked.subject?.kind ?? null) ||
      (subject?.name ?? null) !== (input.checked.subject?.name ?? null)
    ) {
      throw checksChanged();
    }
    if (conversation.people.some((person) => person.userId === input.userId)) {
      return { added: false, conversation };
    }
    if (conversation.people.length >= CONVERSATION_PEOPLE_MAX) {
      throw conversationShareRefusal(
        "share_people_limit",
        `A chat names at most ${CONVERSATION_PEOPLE_MAX} people. Share it with the team, or use a project`,
        { limit: String(CONVERSATION_PEOPLE_MAX) }
      );
    }
    // The membership is held until the row is in: an end of it waits, and then takes the row.
    const [member] = await tx
      .select({ userId: collaborationWorkspaceMemberships.userId })
      .from(collaborationWorkspaceMemberships)
      .innerJoin(
        productUsers,
        and(
          eq(productUsers.clientInstanceId, collaborationWorkspaceMemberships.clientInstanceId),
          eq(productUsers.id, collaborationWorkspaceMemberships.userId)
        )
      )
      .where(
        and(
          eq(collaborationWorkspaceMemberships.clientInstanceId, clientInstanceId),
          eq(
            collaborationWorkspaceMemberships.collaborationWorkspaceId,
            conversation.collaborationWorkspaceId
          ),
          eq(collaborationWorkspaceMemberships.userId, input.userId),
          eq(productUsers.status, "active"),
          isNull(productUsers.deletionRequestedAt)
        )
      )
      .for("share", { of: collaborationWorkspaceMemberships });
    if (!member || input.userId === conversation.createdByUserId) {
      throw personUnavailable();
    }
    await tx.insert(conversationPeople).values({
      clientInstanceId,
      conversationId,
      userId: input.userId,
      addedByUserId: input.addedByUserId,
      addedAt: new Date(input.addedAt)
    });
    const updated = await readConversation(tx, clientInstanceId, conversationId);
    if (!updated) throw new AppError("NOT_FOUND", "Conversation is not available");
    return { added: true, conversation: updated };
  });
}

/** The person cannot be named: no active member of the chat's workspace, or its creator. */
function personUnavailable(): AppError {
  return conversationShareRefusal(
    "share_person_unavailable",
    "Only an active member of the chat's workspace can be named"
  );
}

export async function removeConversationPerson(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; conversationId: ConversationId; userId: string }
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId))) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    // A run of theirs that goes ends first: it acts for them in a chat they would not read.
    const [running] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientInstanceId, input.clientInstanceId),
          eq(agentRuns.conversationId, input.conversationId),
          eq(agentRuns.ownerUserId, input.userId),
          inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES)
        )
      )
      .limit(1);
    if (running) {
      throw conversationShareRefusal(
        "person_run_active",
        "A turn of this person is still running. Try again when it has ended",
        {},
        "CONFLICT"
      );
    }
    const removed = await tx
      .delete(conversationPeople)
      .where(
        and(
          eq(conversationPeople.clientInstanceId, input.clientInstanceId),
          eq(conversationPeople.conversationId, input.conversationId),
          eq(conversationPeople.userId, input.userId)
        )
      )
      .returning({ userId: conversationPeople.userId });
    return removed.length > 0;
  });
}

export async function removePersonFromWorkspaceConversations(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
    collaborationWorkspaceId?: CollaborationWorkspaceId;
  }
): Promise<ConversationId[]> {
  const inWorkspace =
    input.collaborationWorkspaceId === undefined
      ? sql`true`
      : sql`${conversationPeople.conversationId} in (select ${conversations.id} from ${conversations} where ${conversations.clientInstanceId} = ${input.clientInstanceId} and ${conversations.collaborationWorkspaceId} = ${input.collaborationWorkspaceId})`;
  const removed = await db
    .delete(conversationPeople)
    .where(
      and(
        eq(conversationPeople.clientInstanceId, input.clientInstanceId),
        eq(conversationPeople.userId, input.userId),
        inWorkspace
      )
    )
    .returning({ conversationId: conversationPeople.conversationId });
  return removed.map((row) => asConversationId(row.conversationId)).sort();
}

/** Deletes the named people of a moved chat in the move's transaction; answers who they were. */
export async function removeConversationPeople(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
): Promise<string[]> {
  const removed = await tx
    .delete(conversationPeople)
    .where(
      and(
        eq(conversationPeople.clientInstanceId, clientInstanceId),
        eq(conversationPeople.conversationId, conversationId)
      )
    )
    .returning({ userId: conversationPeople.userId });
  return removed.map((row) => row.userId).sort();
}

/** Refuses a chat that names people a place where its readers would be others (PRJ-1). */
export function requireNamesNobody(conversation: Conversation): void {
  if (conversation.people.length > 0) throw conversationHasPeopleError();
}

export async function listShareCandidates(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    creatorUserId: string;
    query?: string;
    limit: number;
  }
): Promise<ConversationShareCandidate[]> {
  const { clientInstanceId, collaborationWorkspaceId, creatorUserId } = input;
  // Those the creator named on a chat of this workspace, most recently first.
  const namedAt = db
    .select({
      userId: conversationPeople.userId,
      at: sql<Date>`max(${conversationPeople.addedAt})`.as("named_at")
    })
    .from(conversationPeople)
    .innerJoin(
      conversations,
      and(
        eq(conversations.clientInstanceId, conversationPeople.clientInstanceId),
        eq(conversations.id, conversationPeople.conversationId)
      )
    )
    .where(
      and(
        eq(conversationPeople.clientInstanceId, clientInstanceId),
        eq(conversationPeople.addedByUserId, creatorUserId),
        eq(conversations.collaborationWorkspaceId, collaborationWorkspaceId)
      )
    )
    .groupBy(conversationPeople.userId)
    .as("named");
  // Then those who most recently sent a message in a chat of it the creator reads: the run's
  // person of each message, so nothing it shows is new to the creator.
  const wroteAt = db
    .select({
      userId: agentRuns.ownerUserId,
      at: sql<Date>`max(${messages.createdAt})`.as("wrote_at")
    })
    .from(messages)
    .innerJoin(
      agentRuns,
      and(
        eq(agentRuns.clientInstanceId, messages.clientInstanceId),
        eq(agentRuns.inputMessageId, messages.id)
      )
    )
    .innerJoin(
      conversations,
      and(
        eq(conversations.clientInstanceId, messages.clientInstanceId),
        eq(conversations.id, messages.conversationId)
      )
    )
    .where(
      and(
        eq(messages.clientInstanceId, clientInstanceId),
        eq(conversations.collaborationWorkspaceId, collaborationWorkspaceId),
        eq(conversations.status, "active"),
        eq(conversations.kind, "chat"),
        readsConversation(creatorUserId)
      )
    )
    .groupBy(agentRuns.ownerUserId)
    .as("wrote");
  const query = input.query?.trim();
  const rows = await db
    .select({
      userId: productUsers.id,
      displayLabel: productUsers.displayLabel,
      email: productUsers.email,
      namedAt: namedAt.at,
      wroteAt: wroteAt.at,
      named: sql<boolean>`exists (select 1 from ${conversationPeople} where ${conversationPeople.clientInstanceId} = ${clientInstanceId} and ${conversationPeople.conversationId} = ${input.conversationId} and ${conversationPeople.userId} = ${productUsers.id})`
    })
    .from(collaborationWorkspaceMemberships)
    .innerJoin(
      productUsers,
      and(
        eq(productUsers.clientInstanceId, collaborationWorkspaceMemberships.clientInstanceId),
        eq(productUsers.id, collaborationWorkspaceMemberships.userId)
      )
    )
    .leftJoin(namedAt, eq(namedAt.userId, productUsers.id))
    .leftJoin(wroteAt, eq(wroteAt.userId, productUsers.id))
    .where(
      and(
        eq(collaborationWorkspaceMemberships.clientInstanceId, clientInstanceId),
        eq(collaborationWorkspaceMemberships.collaborationWorkspaceId, collaborationWorkspaceId),
        eq(productUsers.status, "active"),
        isNull(productUsers.deletionRequestedAt),
        // The creator reads it already.
        ne(productUsers.id, creatorUserId),
        // Only people the creator knows from this workspace, with a query or without: a member
        // cannot list the members (only an Owner or Admin can), and a search must not do so
        // a letter at a time (spec section 5: "among the offered people only").
        or(
          isNotNull(namedAt.at),
          isNotNull(wroteAt.at),
          sql`exists (select 1 from ${conversationPeople} where ${conversationPeople.clientInstanceId} = ${clientInstanceId} and ${conversationPeople.conversationId} = ${input.conversationId} and ${conversationPeople.userId} = ${productUsers.id})`
        ),
        query
          ? or(
              ilike(productUsers.displayLabel, prefixPattern(query)),
              ilike(productUsers.displayLabel, sql`${"% "} || ${prefixPattern(query)}`),
              ilike(productUsers.email, prefixPattern(query))
            )
          : undefined
      )
    )
    .orderBy(
      sql`${namedAt.at} desc nulls last`,
      sql`${wroteAt.at} desc nulls last`,
      asc(productUsers.displayLabel),
      asc(productUsers.id)
    )
    .limit(input.limit);
  // An email is shown only to a search that typed its start: the bare list and a search by
  // name answer names alone.
  const emailQuery = query?.toLocaleLowerCase();
  return rows.map((row) => ({
    userId: row.userId,
    displayLabel: row.displayLabel,
    ...(row.email && emailQuery && row.email.toLocaleLowerCase().startsWith(emailQuery)
      ? { email: row.email }
      : {}),
    hasAccess: row.named
  }));
}
