import {
  ACTIVE_AGENT_RUN_STATUSES,
  type ClientInstanceId,
  type Conversation,
  type ConversationId,
  type ExpireConversationResult
} from "@work-shape/catalyst-core";
import { and, asc, eq, inArray, lte, notExists, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  conversationDraftAttachments,
  conversationMessages,
  lockActiveConversation,
  markLockedConversationTreeDeleted
} from "./postgres-conversation-operations";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { mapConversation } from "./rows";
import { agentRuns, conversations } from "./schema";

// When a chat Conversation expires: its retention is due, or it is a draft nobody wrote to. A
// subagent's run thread never expires alone; its root brings it (CR-1).

const threads = alias(conversations, "thread");

/** The runs in progress of the Conversation of the enclosing statement and of its threads. */
function conversationRunsInProgress(db: PostgresConnection) {
  return db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, conversations.clientInstanceId),
        or(
          eq(agentRuns.conversationId, conversations.id),
          inArray(
            agentRuns.conversationId,
            db
              .select({ id: threads.id })
              .from(threads)
              .where(
                and(
                  eq(threads.clientInstanceId, conversations.clientInstanceId),
                  eq(threads.parentConversationId, conversations.id)
                )
              )
          )
        ),
        inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES)
      )
    );
}

/**
 * The expiry criteria as conditions on a `conversations` row. The list and the claim both use
 * them, so they cannot drift. A Conversation with an agent run in progress, its subagents'
 * included, meets neither, and a run thread never does.
 */
function conversationExpiryCriteria(
  db: PostgresConnection,
  input: { now?: string; abandonedBefore?: string }
): { due: SQL | undefined; abandoned: SQL | undefined } {
  const idle = and(eq(conversations.kind, "chat"), notExists(conversationRunsInProgress(db)));
  return {
    due: input.now ? and(lte(conversations.retainedUntil, new Date(input.now)), idle) : undefined,
    abandoned: input.abandonedBefore
      ? and(
          lte(conversations.updatedAt, new Date(input.abandonedBefore)),
          notExists(conversationMessages(db)),
          notExists(conversationDraftAttachments(db)),
          idle
        )
      : undefined
  };
}

export async function listExpiredConversations(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    now?: string;
    abandonedBefore?: string;
    limit: number;
  }
): Promise<Conversation[]> {
  const criteria = conversationExpiryCriteria(db, input);
  if (!criteria.due && !criteria.abandoned) {
    return [];
  }
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.status, "active"),
        or(criteria.due, criteria.abandoned)
      )
    )
    .orderBy(asc(conversations.retainedUntil), asc(conversations.id))
    .limit(input.limit);
  return rows.map(mapConversation);
}

export async function expireConversation(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    expiredAt: string;
    now?: string;
    abandonedBefore?: string;
  }
): Promise<ExpireConversationResult> {
  return db.transaction(async (tx) => {
    if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId))) {
      return { status: "not_expired" };
    }
    // Evaluated in statements of their own, after the lock is held. A condition inside the
    // locking statement is answered from the snapshot taken before the wait and would miss the
    // message or upload the lock holder just committed.
    const criteria = conversationExpiryCriteria(tx, input);
    const due = await lockedConversationMeets(tx, input, criteria.due);
    if (!due && !(await lockedConversationMeets(tx, input, criteria.abandoned))) {
      return { status: "not_expired" };
    }
    const conversation = await markLockedConversationTreeDeleted(tx, {
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      deletedAt: input.expiredAt,
      status: "retention_expired"
    });
    return {
      status: "expired",
      conversation,
      reason: due ? "retention_due" : "abandoned_draft"
    };
  });
}

async function lockedConversationMeets(
  tx: PostgresTransaction,
  input: { clientInstanceId: ClientInstanceId; conversationId: ConversationId },
  criterion: SQL | undefined
): Promise<boolean> {
  if (!criterion) {
    return false;
  }
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        criterion
      )
    )
    .limit(1);
  return row !== undefined;
}
