import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNull,
  ne,
  or,
  sql
} from "drizzle-orm";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  type ClientInstanceId,
  type ConversationFollowUp,
  type ConversationFollowUpAttachment,
  type ConversationFollowUpStore,
  type FollowUpScope,
  type PrepareConversationRunStartInput,
  type RunObservation
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { lockActiveConversation } from "./postgres-conversation-operations";
import { declineConfirmationsForSteer } from "./postgres-agent-run-decision-operations";
import { mapConversationAttachment } from "./rows";
import {
  agentRuns,
  agentRunObservations,
  conversationFollowUps,
  conversationAttachments,
  runStartCommands,
  conversations,
  collaborationWorkspaceMemberships,
  productUsers
} from "./schema";

// Resolve names at read time: unavailable authors retain their queued messages without a name.
function followUpsWithAuthors(db: PostgresConnection) {
  return db
    .select({
      ...getTableColumns(conversationFollowUps),
      authorDisplayLabel: productUsers.displayLabel
    })
    .from(conversationFollowUps)
    .leftJoin(
      productUsers,
      and(
        eq(productUsers.clientInstanceId, conversationFollowUps.clientInstanceId),
        eq(productUsers.id, conversationFollowUps.authorUserId),
        eq(productUsers.status, "active"),
        isNull(productUsers.deletionRequestedAt),
        exists(
          db
            .select({ id: conversations.id })
            .from(conversations)
            .innerJoin(
              collaborationWorkspaceMemberships,
              and(
                eq(
                  collaborationWorkspaceMemberships.clientInstanceId,
                  conversations.clientInstanceId
                ),
                eq(
                  collaborationWorkspaceMemberships.collaborationWorkspaceId,
                  conversations.collaborationWorkspaceId
                ),
                eq(collaborationWorkspaceMemberships.userId, productUsers.id)
              )
            )
            .where(
              and(
                eq(conversations.clientInstanceId, conversationFollowUps.clientInstanceId),
                eq(conversations.id, conversationFollowUps.conversationId),
                or(
                  eq(conversations.visibility, "workspace"),
                  eq(conversations.createdByUserId, productUsers.id)
                )
              )
            )
        )
      )
    );
}

/** Names are a current-access projection, never part of the durable event payload. */
export async function withFollowUpAuthorLabels(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  observations: RunObservation[]
): Promise<RunObservation[]> {
  const ids = [
    ...new Set(
      observations.flatMap(({ payload }) =>
        payload.type === "follow_up_changed" ? [payload.followUp.id] : []
      )
    )
  ];
  if (ids.length === 0) return observations;
  const rows = await followUpsWithAuthors(db).where(
    and(
      eq(conversationFollowUps.clientInstanceId, clientInstanceId),
      inArray(conversationFollowUps.id, ids)
    )
  );
  const labels = new Map(rows.map((row) => [row.id, row.authorDisplayLabel ?? undefined]));
  return observations.map((observation) => {
    const { payload } = observation;
    if (payload.type !== "follow_up_changed") return observation;
    return {
      ...observation,
      payload: {
        ...payload,
        followUp: { ...payload.followUp, authorDisplayLabel: labels.get(payload.followUp.id) }
      }
    };
  });
}

export function mapFollowUp(
  row: typeof conversationFollowUps.$inferSelect & { authorDisplayLabel?: string | null }
): ConversationFollowUp {
  return {
    id: row.id,
    authorUserId: row.authorUserId,
    authorDisplayLabel: row.authorDisplayLabel ?? undefined,
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

/** The files each pending message carries, so the queue shows them with it (T23). */
async function withFollowUpAttachments(
  db: PostgresConnection,
  followUps: ConversationFollowUp[]
): Promise<ConversationFollowUp[]> {
  const pending = followUps.filter((followUp) => followUp.status === "pending");
  const first = pending[0];
  if (!first) return followUps;
  const rows = await db
    .select({
      followUpId: conversationAttachments.followUpId,
      fileId: conversationAttachments.fileId,
      filename: conversationAttachments.filename,
      mimeType: conversationAttachments.mimeType,
      byteSize: conversationAttachments.byteSize
    })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, first.clientInstanceId),
        inArray(
          conversationAttachments.followUpId,
          pending.map((followUp) => followUp.id)
        ),
        ne(conversationAttachments.status, "deleted")
      )
    )
    .orderBy(asc(conversationAttachments.createdAt), asc(conversationAttachments.id));
  const byFollowUp = new Map<string, ConversationFollowUpAttachment[]>();
  for (const row of rows) {
    if (!row.followUpId) continue;
    const list = byFollowUp.get(row.followUpId) ?? [];
    list.push({
      fileId: row.fileId,
      filename: row.filename,
      ...(row.mimeType ? { mimeType: row.mimeType } : {}),
      byteSize: row.byteSize
    });
    byFollowUp.set(row.followUpId, list);
  }
  return followUps.map((followUp) => {
    const attachments = byFollowUp.get(followUp.id);
    return attachments ? { ...followUp, attachments } : followUp;
  });
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
  const [observed = followUp] =
    followUp.attachments === undefined ? await withFollowUpAttachments(db, [followUp]) : [followUp];
  const event = {
    type: "follow_up_changed" as const,
    runId: asAgentRunId(run.id),
    sequence,
    createdAt: followUp.updatedAt,
    followUp: { ...observed, authorDisplayLabel: undefined }
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

/**
 * Accepts the queued outcome in the same locked transaction as normal run acceptance. With
 * `steerRunId` the message is a steer that only that run takes in (FU-2).
 */
export async function queueFollowUp(
  db: PostgresConnection,
  input: PrepareConversationRunStartInput,
  steerRunId?: string
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
      mode: steerRunId ? "steer" : "queue",
      status: "pending",
      dispatchedRunId: steerRunId ?? null,
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
  const [queued] = await followUpsWithAuthors(db)
    .where(and(scopeWhere(input), eq(conversationFollowUps.id, row.id)))
    .limit(1);
  if (!queued) throw new AppError("INTERNAL", "Follow-up is not available");
  const [followUp = mapFollowUp(queued)] = await withFollowUpAttachments(db, [mapFollowUp(queued)]);
  await observeFollowUpChange(db, followUp);
  return followUp;
}

/**
 * Whether a person's steer may go into this active run (FU-2): only into their own run, one of
 * the conversation itself that is not ending. The credential and the attachments are the
 * caller's to check.
 */
export function runTakesSteerFrom(
  run: typeof agentRuns.$inferSelect,
  authorUserId: string
): boolean {
  return (
    run.ownerUserId === authorUserId &&
    run.status !== "cancelling" &&
    run.parentRunId === null &&
    run.workflowStepRunId === null
  );
}

/**
 * Turns the author's queued message into a steer of their running turn, as if it had been
 * sent with `steer`: same run owner, same credential, no attachments. Otherwise CONFLICT and
 * it stays queued. `queued` is called when a declined confirmation queued the run again.
 */
async function steerQueuedFollowUp(
  db: PostgresConnection,
  input: FollowUpScope & { followUpId: string; authorUserId: string },
  queued: () => void
): Promise<ConversationFollowUp> {
  return db.transaction(async (tx) => {
    if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId)))
      throw new AppError("NOT_FOUND", "Conversation is not available");
    const [item] = await followUpsWithAuthors(tx)
      .where(and(scopeWhere(input), eq(conversationFollowUps.id, input.followUpId)))
      .limit(1);
    if (!item) throw new AppError("NOT_FOUND", "Follow-up is not available");
    if (item.authorUserId !== input.authorUserId)
      throw new AppError("FORBIDDEN", "Only the author may steer with this follow-up");
    if (item.status !== "pending")
      throw new AppError("CONFLICT", "Follow-up was already dispatched");
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientInstanceId, input.clientInstanceId),
          eq(agentRuns.conversationId, input.conversationId),
          inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES)
        )
      )
      .limit(1);
    if (item.mode === "steer" && run && item.dispatchedRunId === run.id) return mapFollowUp(item);
    if (!run || !runTakesSteerFrom(run, input.authorUserId))
      throw new AppError("CONFLICT", "Only your own running turn can be steered");
    const [same] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(conversationFollowUps, eq(conversationFollowUps.id, item.id))
      .where(
        and(
          eq(agentRuns.id, run.id),
          sql`${agentRuns.authorizationContext} = ${conversationFollowUps.authorizationContext}`
        )
      )
      .limit(1);
    if (!same)
      throw new AppError("CONFLICT", "This message was sent with another credential than the run");
    const [attachment] = await tx
      .select({ id: conversationAttachments.id })
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.followUpId, item.id),
          ne(conversationAttachments.status, "deleted")
        )
      )
      .limit(1);
    if (attachment)
      throw new AppError("CONFLICT", "A message with attachments waits for the next turn");
    const [row] = await tx
      .update(conversationFollowUps)
      .set({ mode: "steer", dispatchedRunId: run.id, updatedAt: new Date() })
      .where(eq(conversationFollowUps.id, item.id))
      .returning();
    if (!row) throw new AppError("INTERNAL", "Follow-up was not changed");
    const result = mapFollowUp({ ...row, authorDisplayLabel: item.authorDisplayLabel });
    await observeFollowUpChange(tx, result);
    // A steer while the run waits on its person's confirmation declines that call.
    await declineConfirmationsForSteer(tx, run, queued);
    return result;
  });
}

/** Caller holds the conversation lock. Stop at the first incompatible pending item. */
export async function getPendingFollowUpTurn(db: PostgresConnection, input: FollowUpScope) {
  const pending = and(scopeWhere(input), eq(conversationFollowUps.status, "pending"));
  const [first] = await db
    .select()
    .from(conversationFollowUps)
    .where(pending)
    .orderBy(asc(conversationFollowUps.position))
    .limit(1);
  if (!first) return [];
  // JSONB equality includes principal, delegation and scopes: one credential cannot lend
  // its rights to a message accepted under another, even for the same person.
  const [boundary] = await db
    .select({ position: conversationFollowUps.position })
    .from(conversationFollowUps)
    .where(
      and(
        pending,
        sql`${conversationFollowUps.position} > ${first.position}`,
        sql`(${conversationFollowUps.authorUserId}, ${conversationFollowUps.agentName},
        ${conversationFollowUps.modelBindingId}, ${conversationFollowUps.reasoningEffort},
        ${conversationFollowUps.authorizationContext}) is distinct from
        (${first.authorUserId}::text, ${first.agentName}::text, ${first.modelBindingId}::text,
        ${first.reasoningEffort}::text, ${first.authorizationContext === null ? null : JSON.stringify(first.authorizationContext)}::jsonb)`
      )
    )
    .orderBy(asc(conversationFollowUps.position))
    .limit(1);
  return db
    .select()
    .from(conversationFollowUps)
    .where(
      and(
        pending,
        boundary ? sql`${conversationFollowUps.position} < ${boundary.position}` : undefined
      )
    )
    .orderBy(asc(conversationFollowUps.position));
}

/** `enqueued` is called for every job this store inserts, before its transaction commits. */
export function createPostgresFollowUpStore(
  db: PostgresConnection,
  deps: { lockActiveConversation: typeof lockActiveConversation; enqueued: () => void }
): ConversationFollowUpStore {
  const pending = (input: FollowUpScope, connection: PostgresConnection = db) =>
    followUpsWithAuthors(connection)
      .where(and(scopeWhere(input), eq(conversationFollowUps.status, "pending")))
      .orderBy(asc(conversationFollowUps.position));
  return {
    async listPending(input) {
      return withFollowUpAttachments(db, (await pending(input)).map(mapFollowUp));
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
    async getPendingTurn(input) {
      return db.transaction(async (tx) => {
        if (!(await deps.lockActiveConversation(tx, input.clientInstanceId, input.conversationId)))
          return [];
        return (await getPendingFollowUpTurn(tx, input)).map(mapFollowUp);
      });
    },
    async get(input) {
      const [row] = await followUpsWithAuthors(db)
        .where(and(scopeWhere(input), eq(conversationFollowUps.id, input.followUpId)))
        .limit(1);
      return row && mapFollowUp(row);
    },
    async findByIdempotencyKey(input) {
      const [row] = await followUpsWithAuthors(db)
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
    async steer(input) {
      let resumed = false;
      const followUp = await steerQueuedFollowUp(db, input, () => {
        resumed = true;
      });
      if (resumed) deps.enqueued();
      return followUp;
    },
    async cancel(input) {
      return db.transaction(async (tx) => {
        if (!(await deps.lockActiveConversation(tx, input.clientInstanceId, input.conversationId)))
          throw new AppError("NOT_FOUND", "Conversation is not available");
        const [item] = await followUpsWithAuthors(tx)
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
        // Edit hands the message back to the composer with its files; Remove deletes them.
        await tx
          .update(conversationAttachments)
          .set(
            input.keepAttachments
              ? { followUpId: null, updatedAt: now }
              : { status: "deleted", deletedAt: now, updatedAt: now }
          )
          .where(
            and(
              eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
              eq(conversationAttachments.followUpId, item.id)
            )
          );
        if (!row) throw new AppError("INTERNAL", "Follow-up was not cancelled");
        const result = mapFollowUp({ ...row, authorDisplayLabel: item.authorDisplayLabel });
        await observeFollowUpChange(tx, result);
        return result;
      });
    }
  };
}
