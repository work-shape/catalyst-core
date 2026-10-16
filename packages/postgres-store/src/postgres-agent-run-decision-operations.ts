import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  AppError,
  agentRunJobOptions,
  executeAgentRunJob,
  type AgentRuntimeEvent,
  type DecideWaitingToolCallInput,
  type DecidedWaitingToolCall
} from "@work-shape/catalyst-core";
import { enqueueJob } from "./jobs/store";
import type { PostgresConnection } from "./postgres-database";
import { mapOperationRun } from "./postgres-operation-run-operations";
import { mapAgentRun } from "./rows";
import { agentRunObservations, agentRuns, operationRuns } from "./schema";

// A person's decision on a call an Agent Run waits on (EW-2a): recorded on the call's
// Operation Run and as an event of the run, and the run queued again once nothing it waits on
// is undecided. All of it in one transaction.

/**
 * Records the decision. A confirmed call keeps waiting with its decision until the run's
 * worker takes it for execution; a declined one is denied at once. The same decision again
 * changes nothing and answers the same runs; another decision is a CONFLICT, as is a decision
 * on a call whose time ran out. `enqueued` is called when a job was inserted.
 */
export async function decideWaitingToolCall(
  db: PostgresConnection,
  input: DecideWaitingToolCallInput,
  enqueued: () => void
): Promise<DecidedWaitingToolCall> {
  let queued = false;
  const decided = await db.transaction(async (tx) => {
    const ofOperationRun = and(
      eq(operationRuns.clientInstanceId, input.clientInstanceId),
      eq(operationRuns.id, sql`${input.operationRunId}`)
    );
    const [seen] = await tx.select().from(operationRuns).where(ofOperationRun).limit(1);
    const origin = seen?.origin;
    if (origin?.kind !== "agent") {
      throw new AppError("NOT_FOUND", "This call is not available");
    }
    // Match queue changes, then lock the run before its call.
    await lockAgentRunConversations(tx, input.clientInstanceId, [origin.agentRunId]);
    const [runRow] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientInstanceId, input.clientInstanceId),
          eq(agentRuns.id, origin.agentRunId)
        )
      )
      .limit(1)
      .for("update");
    if (!runRow) throw new AppError("NOT_FOUND", "This call is not available");
    if (runRow.ownerUserId !== input.deciderUserId) {
      throw new AppError("FORBIDDEN", "Only the person the run works for decides its calls");
    }
    const [callRow] = await tx.select().from(operationRuns).where(ofOperationRun).for("update");
    if (!callRow) throw new AppError("NOT_FOUND", "This call is not available");

    const earlier = callRow.decision?.mode;
    if (earlier === "confirmed" || earlier === "declined") {
      if (earlier !== input.decision.mode) {
        throw new AppError(
          "CONFLICT",
          `This call was already ${earlier}. It cannot be ${input.decision.mode} any more.`,
          { operationRunId: callRow.id }
        );
      }
      return {
        operationRun: mapOperationRun(callRow),
        agentRun: mapAgentRun(runRow),
        repeated: true
      };
    }
    const resumeState = runRow.resumeState;
    const waitedOn = resumeState?.waiting.find((entry) => entry.operationRunId === callRow.id);
    if (callRow.status !== "pending_confirmation" || runRow.status !== "waiting_for_decision") {
      throw notWaiting(callRow.status === "expired");
    }
    if (!resumeState || !waitedOn) throw notWaiting(false);

    const declined = input.decision.mode === "declined" ? input.declined : undefined;
    if (input.decision.mode === "declined" && !declined) {
      throw new AppError("VALIDATION_FAILED", "A declined call needs how its run ends");
    }
    const decidedAt = new Date(input.decision.at);
    // Only a call whose time has not run out by the database's clock is decided.
    const [updated] = await tx
      .update(operationRuns)
      .set({
        decision: input.decision,
        updatedAt: decidedAt,
        ...(declined
          ? {
              status: "denied",
              finishedAt: decidedAt,
              error: { ...declined.error, denial: declined.denial }
            }
          : {})
      })
      .where(
        and(
          ofOperationRun,
          eq(operationRuns.status, "pending_confirmation"),
          isNull(operationRuns.decision),
          gt(operationRuns.expiresAt, sql`now()`)
        )
      )
      .returning();
    if (!updated) throw notWaiting(true);

    const undecided = await tx
      .select({ id: operationRuns.id })
      .from(operationRuns)
      .where(
        and(
          eq(operationRuns.clientInstanceId, input.clientInstanceId),
          inArray(
            operationRuns.id,
            resumeState.waiting.map((entry) => entry.operationRunId)
          ),
          isNull(operationRuns.decision)
        )
      );
    const resumes = undecided.length === 0;
    const event: AgentRuntimeEvent = {
      type: "tool_decision_recorded",
      runId: origin.agentRunId,
      sequence: runRow.lastSequence + 1,
      createdAt: decidedAt.toISOString(),
      toolCallId: origin.toolCallId,
      operationRunId: updated.id,
      outcome: input.decision.mode,
      decidedBy: input.deciderUserId,
      ...(input.decision.comment ? { reason: input.decision.comment } : {})
    };
    const [run] = await tx
      .update(agentRuns)
      .set({
        lastSequence: event.sequence,
        updatedAt: sql`now()`,
        // The run goes on once nothing it waits on is undecided: queued, with its job.
        ...(resumes ? { status: "queued" as const } : {})
      })
      .where(
        and(
          eq(agentRuns.clientInstanceId, input.clientInstanceId),
          eq(agentRuns.id, runRow.id),
          eq(agentRuns.lastSequence, runRow.lastSequence)
        )
      )
      .returning();
    if (!run) throw new AppError("CONFLICT", "The run changed while the call was decided");
    await tx.insert(agentRunObservations).values({
      clientInstanceId: run.clientInstanceId,
      runId: run.id,
      conversationId: run.conversationId,
      ownerUserId: run.ownerUserId,
      sequence: event.sequence,
      type: event.type,
      payload: event,
      createdAt: decidedAt
    });
    const agentRun = mapAgentRun(run);
    if (resumes) {
      await enqueueJob(
        tx,
        executeAgentRunJob,
        { runId: agentRun.id },
        agentRunJobOptions(agentRun)
      );
      queued = true;
    }
    return { operationRun: mapOperationRun(updated), agentRun, repeated: false };
  });
  if (queued) enqueued();
  return decided;
}

function notWaiting(expired: boolean): AppError {
  return new AppError(
    "CONFLICT",
    expired
      ? "This call expired before it was decided. Nothing was executed."
      : "This call does not wait for a decision any more."
  );
}
