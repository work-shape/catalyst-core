import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  type ConversationFollowUp,
  type ConversationFollowUpStore,
  type FollowUpScope,
  type PrepareConversationRunStartInput
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { lockActiveConversation } from "./postgres-conversation-operations";
import { mapConversationAttachment } from "./rows";
import {
  agentRuns,
  agentRunObservations,
  conversationFollowUps,
  conversationAttachments,
  runStartCommands,
  conversations
} from "./schema";

export function mapFollowUp(row: typeof conversationFollowUps.$inferSelect): ConversationFollowUp {
  return {
    id: row.id,
    authorUserId: row.authorUserId,
    text: row.text,
    mode: row.mode,
    status: row.status,
    position: row.position,
    agentName: row.agentName,
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    conversationId: asConversationId(row.conversationId),
    modelBindingId: row.modelBindingId ?? undefined,
    reasoningEffort: row.reasoningEffort ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    dispatchedRunId: row.dispatchedRunId ? asAgentRunId(row.dispatchedRunId) : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function scopeWhere(input: FollowUpScope) {
  return and(
    eq(conversationFollowUps.clientInstanceId, input.clientInstanceId),
    eq(conversationFollowUps.conversationId, input.conversationId)
  );
}

/** The caller holds the conversation lock. The run lock serializes with worker observations. */
export async function observeFollowUpChange(
  db: PostgresConnection,
  followUp: ConversationFollowUp
): Promise<void> {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, followUp.clientInstanceId),
        eq(agentRuns.conversationId, followUp.conversationId),
        inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES)
      )
    )
    .for("update")
    .limit(1);
  if (!run) return;
  const sequence = run.lastSequence + 1;
  const event = {
    type: "follow_up_changed" as const,
    runId: asAgentRunId(run.id),
    sequence,
    createdAt: followUp.updatedAt,
    followUp
  };
  await db.insert(agentRunObservations).values({
    clientInstanceId: run.clientInstanceId,
    runId: run.id,
    conversationId: run.conversationId,
    ownerUserId: run.ownerUserId,
    sequence,
    type: event.type,
    payload: event,
    createdAt: new Date(event.createdAt)
  });
  await db.update(agentRuns).set({ lastSequence: sequence }).where(eq(agentRuns.id, run.id));
}

/** Accepts the queued outcome in the same locked transaction as normal run acceptance. */
export async function queueFollowUp(
  db: PostgresConnection,
  input: PrepareConversationRunStartInput
): Promise<ConversationFollowUp> {
  const [last] = await db
    .select({ position: conversationFollowUps.position })
    .from(conversationFollowUps)
    .where(scopeWhere(input))
    .orderBy(desc(conversationFollowUps.position))
    .limit(1);
  const now = new Date();
  const [row] = await db
    .insert(conversationFollowUps)
    .values({
      id: createPlatformId("fu"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      authorUserId: input.ownerUserId,
      text: input.userMessage.text,
      mode: "queue",
      status: "pending",
      position: (last?.position ?? 0) + 1,
      agentName: input.run.agentName,
      modelBindingId: input.followUpSelection?.modelBindingId ?? input.run.modelBindingId,
      reasoningEffort: input.followUpSelection?.reasoningEffort ?? input.run.reasoningEffort,
      idempotencyKey: input.run.idempotencyKey,
      authorizationContext: input.run.authorization,
      createdAt: now,
      updatedAt: now
    })
    .returning();
  if (!row) throw new AppError("INTERNAL", "Follow-up was not stored");
  // Every ready draft is claimed here, even when no optional manifest handler recognizes it.
  await db
    .update(conversationAttachments)
    .set({ followUpId: row.id, updatedAt: now })
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        eq(conversationAttachments.status, "ready"),
        isNull(conversationAttachments.messageId),
        isNull(conversationAttachments.followUpId)
      )
    );
  if (input.runStartCommand) {
    const [completed] = await db
      .update(runStartCommands)
      .set({ status: "completed", conversationId: input.conversationId, updatedAt: now })
      .where(
        and(
          eq(runStartCommands.clientInstanceId, input.clientInstanceId),
          eq(runStartCommands.ownerUserId, input.ownerUserId),
          eq(runStartCommands.commandKind, input.runStartCommand.commandKind),
          eq(runStartCommands.idempotencyKey, input.runStartCommand.idempotencyKey),
          eq(runStartCommands.status, "pending"),
          input.runStartCommand.claimedAt
            ? eq(runStartCommands.updatedAt, new Date(input.runStartCommand.claimedAt))
            : undefined
        )
      )
      .returning({ status: runStartCommands.status });
    if (!completed) throw new AppError("CONFLICT", "Run start command is no longer held");
  }
  await db
    .update(conversations)
    .set({
      updatedAt: now,
      ...(input.extendRetentionDays === undefined
        ? {}
        : {
            retainedUntil: sql<Date>`greatest(${conversations.retainedUntil}, now() + make_interval(days => ${input.extendRetentionDays}))`
          })
    })
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId)
      )
    );
  const followUp = mapFollowUp(row);
  await observeFollowUpChange(db, followUp);
  return followUp;
}

export function createPostgresFollowUpStore(
  db: PostgresConnection,
  deps: { lockActiveConversation: typeof lockActiveConversation }
): ConversationFollowUpStore {
  const pending = (input: FollowUpScope, connection: PostgresConnection = db) =>
    connection
      .select()
      .from(conversationFollowUps)
      .where(and(scopeWhere(input), eq(conversationFollowUps.status, "pending")))
      .orderBy(asc(conversationFollowUps.position));
  return {
    async listPending(input) {
      return (await pending(input)).map(mapFollowUp);
    },
    async getOldestPending(input) {
      return db.transaction(async (tx) => {
        // A completion may enqueue its wake-up while a send still holds this lock. Wait
        // for that acceptance before deciding that there is no follow-up to dispatch.
        if (!(await deps.lockActiveConversation(tx, input.clientInstanceId, input.conversationId)))
          return undefined;
        const [row] = await pending(input, tx).limit(1);
        return row && mapFollowUp(row);
      });
    },
    async get(input) {
      const [row] = await db
        .select()
        .from(conversationFollowUps)
        .where(and(scopeWhere(input), eq(conversationFollowUps.id, input.followUpId)))
        .limit(1);
      return row && mapFollowUp(row);
    },
    async findByIdempotencyKey(input) {
      const [row] = await db
        .select()
        .from(conversationFollowUps)
        .where(
          and(
            scopeWhere(input),
            eq(conversationFollowUps.authorUserId, input.authorUserId),
            eq(conversationFollowUps.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      return row && mapFollowUp(row);
    },
    async getAuthorization(input) {
      const [row] = await db
        .select({ authorization: conversationFollowUps.authorizationContext })
        .from(conversationFollowUps)
        .where(and(scopeWhere(input), eq(conversationFollowUps.id, input.followUpId)))
        .limit(1);
      return row?.authorization ?? undefined;
    },
    async listAttachments(input) {
      return (
        await db
          .select()
          .from(conversationAttachments)
          .where(
            and(
              eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
              eq(conversationAttachments.conversationId, input.conversationId),
              eq(conversationAttachments.followUpId, input.followUpId),
              ne(conversationAttachments.status, "deleted")
            )
          )
          .orderBy(asc(conversationAttachments.createdAt), asc(conversationAttachments.id))
      ).map(mapConversationAttachment);
    },
    async cancel(input) {
      return db.transaction(async (tx) => {
        if (!(await deps.lockActiveConversation(tx, input.clientInstanceId, input.conversationId)))
          throw new AppError("NOT_FOUND", "Conversation is not available");
        const [item] = await tx
          .select()
          .from(conversationFollowUps)
          .where(and(scopeWhere(input), eq(conversationFollowUps.id, input.followUpId)))
          .limit(1);
        if (!item) throw new AppError("NOT_FOUND", "Follow-up is not available");
        if (input.authorUserId && item.authorUserId !== input.authorUserId)
          throw new AppError("FORBIDDEN", "Only the author may withdraw this follow-up");
        if (item.status === "cancelled") return mapFollowUp(item);
        if (item.status !== "pending")
          throw new AppError("CONFLICT", "Follow-up was already dispatched");
        const now = new Date();
        const [row] = await tx
          .update(conversationFollowUps)
          .set({ status: "cancelled", updatedAt: now })
          .where(eq(conversationFollowUps.id, item.id))
          .returning();
        await tx
          .update(conversationAttachments)
          .set({ status: "deleted", deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
              eq(conversationAttachments.followUpId, item.id)
            )
          );
        if (!row) throw new AppError("INTERNAL", "Follow-up was not cancelled");
        const result = mapFollowUp(row);
        await observeFollowUpChange(tx, result);
        return result;
      });
    }
  };
}
