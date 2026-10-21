import { createHash } from "node:crypto";
import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  AppError,
  asClientInstanceId,
  canonicalJson,
  type JsonValue,
  isJsonObject,
  DECISION_EXPIRED_REASON,
  operationDenialError,
  type OperationDenial,
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
    // A confirmation that waits in the person's Inbox is decided there and nowhere else, so
    // one call never has two answers (OP-4b).
    if (callRow.status === "pending_confirmation" && callRow.approvalRequestId) {
      throw new AppError(
        "CONFLICT",
        `This call waits in your Inbox as request ${callRow.approvalRequestId}. Decide it there.`,
        { operationRunId: callRow.id, approvalRequestId: callRow.approvalRequestId }
      );
    }

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

    if (input.audience !== undefined) {
      if (
        input.decision.mode !== "confirmed" ||
        callRow.operation !== "assets.publish" ||
        !isJsonObject(waitedOn.frozenInput) ||
        waitedOn.frozenInput.kind !== "app"
      ) {
        throw new AppError(
          "VALIDATION_FAILED",
          "An audience can only be chosen when confirming an App publish"
        );
      }
      waitedOn.frozenInput = { ...waitedOn.frozenInput, audience: input.audience };
    }
    const declined = input.decision.mode === "declined" ? input.declined : undefined;
    if (input.decision.mode === "declined" && !declined) {
      throw new AppError("VALIDATION_FAILED", "A declined call needs how its run ends");
    }
    const decidedAt = new Date(input.decision.at);
    // Only a call whose time has not run out by the database's clock is decided.
    const [updated] = await tx
      .update(operationRuns)
      .set({
        decision: {
          ...input.decision,
          ...(input.audience
            ? { edited: true, inputHashes: [callRow.inputHash, hashInput(waitedOn.frozenInput)] }
            : {})
        },
        ...(input.audience ? { inputHash: hashInput(waitedOn.frozenInput) } : {}),
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
        resumeState,
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

/**
 * A steer while its run waits on its person's confirmation declines each such call (FU-2):
 * denied, reason `steered`, decided by the run's person, who sent it. A call that waits in
 * the Inbox or for another person's approval is left waiting, and the steer pending until the
 * run resumes. Runs in the transaction that stored the steer, under its conversation lock.
 * `queued` is called when the run was queued again.
 */
export async function declineConfirmationsForSteer(
  tx: PostgresConnection,
  run: typeof agentRuns.$inferSelect,
  queued: () => void
): Promise<void> {
  if (run.status !== "waiting_for_decision" || !run.ownerUserId || !run.resumeState) return;
  const clientInstanceId = asClientInstanceId(run.clientInstanceId);
  const waiting = run.resumeState.waiting.map((entry) => entry.operationRunId);
  if (waiting.length === 0) return;
  const calls = await tx
    .select({ id: operationRuns.id })
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, clientInstanceId),
        inArray(operationRuns.id, waiting),
        eq(operationRuns.status, "pending_confirmation"),
        isNull(operationRuns.decision),
        isNull(operationRuns.approvalRequestId),
        gt(operationRuns.expiresAt, sql`now()`)
      )
    );
  const denial: OperationDenial = { kind: "declined", by: run.ownerUserId, reason: "steered" };
  const error = operationDenialError(denial);
  const at = new Date().toISOString();
  for (const call of calls) {
    await decideWaitingToolCall(
      tx,
      {
        clientInstanceId,
        operationRunId: call.id,
        deciderUserId: run.ownerUserId,
        decision: { mode: "declined", by: run.ownerUserId, at },
        declined: { error: { code: error.code, message: error.message, reason: "steered" }, denial }
      },
      queued
    );
  }
}

function notWaiting(expired: boolean): AppError {
  return expired
    ? new AppError("CONFLICT", "This call expired before it was decided. Nothing was executed.", {
        reason: DECISION_EXPIRED_REASON
      })
    : new AppError("CONFLICT", "This call does not wait for a decision any more.");
}

/** Matches the operation runner's hash of the person's chosen, frozen input. */
function hashInput(input: JsonValue): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
