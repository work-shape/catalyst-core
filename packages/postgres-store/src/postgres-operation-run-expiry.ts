import {
  WAITING_OPERATION_RUN_STATUSES,
  agentRunJobOptions,
  executeAgentRunJob,
  type AgentRuntimeEvent,
  type OperationRunStore
} from "@work-shape/catalyst-core";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { enqueueJob } from "./jobs/store";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { mapAgentRun } from "./rows";
import { agentRunObservations, agentRuns, operationRuns } from "./schema";

/** Expiry, its observations and the resume job commit together, including across a restart. */
export async function expireOperationRunsAndResumeAgents(
  db: PostgresConnection,
  input: Parameters<OperationRunStore["markExpired"]>[0]
): Promise<(typeof operationRuns.$inferSelect)[]> {
  return db.transaction(async (tx) => {
    // A timely confirmation is never expired while waiting for its worker.
    const due = and(
      eq(operationRuns.clientInstanceId, input.clientInstanceId),
      inArray(operationRuns.status, WAITING_OPERATION_RUN_STATUSES),
      lte(operationRuns.expiresAt, sql`now()`),
      or(ne(operationRuns.status, "pending_confirmation"), isNull(operationRuns.decision))
    );
    const candidates = await tx
      .select()
      .from(operationRuns)
      .where(due)
      .orderBy(asc(operationRuns.expiresAt), asc(operationRuns.id))
      .limit(input.limit);
    if (!candidates.length) return [];
    const runIds = candidates.flatMap((call) =>
      call.origin.kind === "agent" ? [call.origin.agentRunId] : []
    );
    // Match decide and Stop's lock order. Sort several locks so concurrent sweeps agree too.
    const runs = runIds.length
      ? await tx
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.clientInstanceId, input.clientInstanceId),
              inArray(agentRuns.id, runIds)
            )
          )
          .orderBy(asc(agentRuns.id))
          .for("update")
      : [];
    // Recheck after taking the locks: Stop or a decision may have won the race.
    const expired = await tx
      .update(operationRuns)
      .set({
        status: "expired",
        finishedAt: sql`now()`,
        updatedAt: sql`now()`
      })
      .where(
        and(
          due,
          inArray(
            operationRuns.id,
            candidates.map((call) => call.id)
          )
        )
      )
      .returning();
    for (const run of runs) {
      await resumeAfterExpiry(tx, run, expired);
    }
    const byId = new Map(expired.map((row) => [row.id, row]));
    return candidates.flatMap((row) => {
      const ended = byId.get(row.id);
      return ended ? [ended] : [];
    });
  });
}

async function resumeAfterExpiry(
  tx: PostgresTransaction,
  run: typeof agentRuns.$inferSelect,
  expired: (typeof operationRuns.$inferSelect)[]
): Promise<void> {
  const agentRun = mapAgentRun(run);
  const resume = run.resumeState;
  if (run.status !== "waiting_for_decision" || !resume) return;
  const events: AgentRuntimeEvent[] = [];
  for (const call of expired) {
    if (
      call.origin.kind !== "agent" ||
      call.origin.agentRunId !== run.id ||
      !resume.waiting.some((waiting) => waiting.operationRunId === call.id)
    )
      continue;
    events.push({
      type: "tool_decision_recorded",
      runId: agentRun.id,
      sequence: run.lastSequence + events.length + 1,
      createdAt: call.updatedAt.toISOString(),
      toolCallId: call.origin.toolCallId,
      operationRunId: call.id,
      outcome: "expired"
    });
  }
  if (!events.length) return;
  const undecided = await tx
    .select({ id: operationRuns.id })
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, agentRun.clientInstanceId),
        inArray(
          operationRuns.id,
          resume.waiting.map((waiting) => waiting.operationRunId)
        ),
        inArray(operationRuns.status, WAITING_OPERATION_RUN_STATUSES),
        isNull(operationRuns.decision)
      )
    );
  const resumes = undecided.length === 0;
  const [updated] = await tx
    .update(agentRuns)
    .set({
      lastSequence: run.lastSequence + events.length,
      updatedAt: sql`now()`,
      ...(resumes ? { status: "queued" as const } : {})
    })
    .where(and(eq(agentRuns.clientInstanceId, run.clientInstanceId), eq(agentRuns.id, run.id)))
    .returning();
  await tx.insert(agentRunObservations).values(
    events.map((payload) => ({
      clientInstanceId: run.clientInstanceId,
      runId: run.id,
      conversationId: run.conversationId,
      ownerUserId: run.ownerUserId,
      sequence: payload.sequence,
      type: payload.type,
      payload,
      createdAt: new Date(payload.createdAt)
    }))
  );
  if (resumes) {
    const agentRun = mapAgentRun(updated);
    await enqueueJob(tx, executeAgentRunJob, { runId: agentRun.id }, agentRunJobOptions(agentRun));
  }
}
