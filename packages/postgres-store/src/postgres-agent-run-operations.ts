import { and, asc, eq, gt, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AppendRunObservationInput,
  type ClientInstanceId,
  type ConversationId,
  type CreateAgentRunInput,
  type RunObservation,
  type UpdateAgentRunStatusInput
} from "@vivd-catalyst/core";
import type { PostgresDatabase } from "./postgres-database";
import { mapAgentRun, mapRunObservation } from "./rows";
import { agentRunObservations, agentRuns } from "./schema";

export async function createAgentRun(
  db: PostgresDatabase,
  input: CreateAgentRunInput
): Promise<AgentRun> {
  const now = input.startedAt ? new Date(input.startedAt) : new Date();
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: input.id,
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      inputMessageId: input.inputMessageId,
      agentName: input.agentName,
      status: "running",
      idempotencyKey: input.idempotencyKey,
      startedAt: now,
      updatedAt: now,
      lastSequence: 0,
      correlationId: input.correlationId
    })
    .returning();
  return mapAgentRun(row);
}

export async function getAgentRun(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
  }
): Promise<AgentRun | undefined> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId)))
    .limit(1);
  return row ? mapAgentRun(row) : undefined;
}

export async function getConversationAgentRun(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    runId: AgentRunId;
  }
): Promise<AgentRun | undefined> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        eq(agentRuns.conversationId, input.conversationId),
        eq(agentRuns.id, input.runId)
      )
    )
    .limit(1);
  return row ? mapAgentRun(row) : undefined;
}

export async function updateAgentRunStatus(
  db: PostgresDatabase,
  input: UpdateAgentRunStatusInput
): Promise<AgentRun> {
  const [row] = await db
    .update(agentRuns)
    .set({
      status: input.status,
      updatedAt: new Date(input.updatedAt),
      lastSequence: input.lastSequence,
      completedAt: input.completedAt ? new Date(input.completedAt) : undefined,
      cancelledAt: input.cancelledAt ? new Date(input.cancelledAt) : undefined,
      failedAt: input.failedAt ? new Date(input.failedAt) : undefined,
      error: input.error
    })
    .where(and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId)))
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "Agent run is not available");
  }
  return mapAgentRun(row);
}

export async function appendRunObservation(
  db: PostgresDatabase,
  input: AppendRunObservationInput
): Promise<RunObservation> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientInstanceId, input.clientInstanceId),
          eq(agentRuns.conversationId, input.conversationId),
          eq(agentRuns.id, input.runId),
          eq(agentRuns.ownerUserId, input.ownerUserId)
        )
      )
      .limit(1);
    if (!run) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }

    const [row] = await tx
      .insert(agentRunObservations)
      .values({
        clientInstanceId: input.clientInstanceId,
        runId: input.runId,
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        sequence: input.event.sequence,
        type: input.event.type,
        payload: input.event,
        createdAt: new Date(input.event.createdAt)
      })
      .returning();

    await tx
      .update(agentRuns)
      .set({
        lastSequence: drizzleSql<number>`greatest(${agentRuns.lastSequence}, ${input.event.sequence})`,
        updatedAt: new Date(input.event.createdAt)
      })
      .where(and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId)));

    return mapRunObservation(row);
  });
}

export async function listRunObservations(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
    ownerUserId: string;
    afterSequence?: number;
    limit?: number;
  }
): Promise<RunObservation[]> {
  const query = db
    .select()
    .from(agentRunObservations)
    .where(
      and(
        eq(agentRunObservations.clientInstanceId, input.clientInstanceId),
        eq(agentRunObservations.runId, input.runId),
        eq(agentRunObservations.ownerUserId, input.ownerUserId),
        gt(agentRunObservations.sequence, input.afterSequence ?? 0)
      )
    )
    .orderBy(asc(agentRunObservations.sequence));
  const rows = input.limit === undefined ? await query : await query.limit(input.limit);
  return rows.map(mapRunObservation);
}
