import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import { withdrawStoppedOperationApproval } from "./postgres-agent-run-approval-withdrawal";
import {
  AppError,
  type AgentRun,
  type AgentRuntimeEvent,
  type RequestAgentRunCancellationInput
} from "@work-shape/catalyst-core";
import { and, eq } from "drizzle-orm";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { mapAgentRun } from "./rows";
import { agentRunObservations, agentRuns, operationRuns } from "./schema";

/** Stop settles an unowned run here; only a running worker needs a cancellation signal. */
export async function requestAgentRunCancellation(
  db: PostgresConnection,
  input: RequestAgentRunCancellationInput
): Promise<AgentRun> {
  return db.transaction(async (tx) => {
    // Match queue changes before locking the run and its operation runs.
    await lockAgentRunConversations(tx, input.clientInstanceId, [input.runId]);
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId))
      )
      .for("update");
    if (!run) throw new AppError("NOT_FOUND", "Agent run is not available");
    const requestedAt = new Date(input.requestedAt);
    if (run.status === "queued" || run.status === "waiting_for_decision") {
      const decisions = await cancelWaitingCalls(tx, run, input);
      const event: AgentRuntimeEvent = {
        type: "run_cancelled",
        runId: input.runId,
        sequence: run.lastSequence + decisions.length + 1,
        createdAt: input.requestedAt,
        ...(input.reason ? { reason: input.reason } : {})
      };
      const [cancelled] = await tx
        .update(agentRuns)
        .set({
          status: "cancelled",
          cancellationRequestedAt: requestedAt,
          cancellationReason: input.reason,
          cancelledAt: requestedAt,
          updatedAt: requestedAt,
          lastSequence: event.sequence,
          resumeState: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null
        })
        .where(
          and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, run.id))
        )
        .returning();
      await tx.insert(agentRunObservations).values(
        [...decisions, event].map((payload) => ({
          clientInstanceId: run.clientInstanceId,
          runId: input.runId,
          conversationId: run.conversationId,
          ownerUserId: run.ownerUserId,
          sequence: payload.sequence,
          type: payload.type,
          payload,
          createdAt: requestedAt
        }))
      );
      return mapAgentRun(cancelled);
    }
    if (run.status === "running" || run.status === "cancelling") {
      // A resumed worker may have claimed the run without taking its approved call yet.
      // The call's row lock decides whether Stop or execution won; never end a taken call.
      await cancelWaitingCalls(tx, run, input, false);
      const [cancelling] = await tx
        .update(agentRuns)
        .set({
          status: "cancelling",
          cancellationRequestedAt: requestedAt,
          cancellationReason: input.reason,
          updatedAt: requestedAt
        })
        .where(
          and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, run.id))
        )
        .returning();
      return mapAgentRun(cancelling);
    }
    return mapAgentRun(run);
  });
}

async function cancelWaitingCalls(
  tx: PostgresTransaction,
  run: typeof agentRuns.$inferSelect,
  input: RequestAgentRunCancellationInput,
  recordDecision = true
): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for (const waiting of run.resumeState?.waiting ?? []) {
    const [call] = await tx
      .select()
      .from(operationRuns)
      .where(
        and(
          eq(operationRuns.clientInstanceId, input.clientInstanceId),
          eq(operationRuns.id, waiting.operationRunId)
        )
      )
      .for("update");
    if (!call || (call.status !== "pending_confirmation" && call.status !== "pending_approval"))
      continue;
    if (call.origin.kind !== "agent" || call.origin.agentRunId !== run.id) continue;
    await tx
      .update(operationRuns)
      .set({
        status: "denied",
        finishedAt: new Date(input.requestedAt),
        updatedAt: new Date(input.requestedAt),
        error: {
          code: "POLICY_DENIED",
          reason: "cancelled",
          message: "The run was cancelled. Nothing ran.",
          denial: { kind: "policy", operation: call.operation }
        }
      })
      .where(
        and(
          eq(operationRuns.clientInstanceId, input.clientInstanceId),
          eq(operationRuns.id, call.id)
        )
      );
    await withdrawStoppedOperationApproval(tx, call, new Date(input.requestedAt));
    // An owned worker allocates its own observation sequence and records cancellation.
    if (!recordDecision) continue;
    events.push({
      type: "tool_decision_recorded",
      runId: input.runId,
      sequence: run.lastSequence + events.length + 1,
      createdAt: input.requestedAt,
      toolCallId: call.origin.toolCallId,
      operationRunId: call.id,
      outcome: "cancelled",
      reason: "cancelled"
    });
  }
  return events;
}
