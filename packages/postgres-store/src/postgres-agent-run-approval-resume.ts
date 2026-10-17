import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import {
  agentRunJobOptions,
  asAgentRunId,
  asToolCallId,
  asClientInstanceId,
  executeAgentRunJob,
  type AgentRuntimeEvent,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { enqueueJob } from "./jobs/store";
import type { PostgresConnection } from "./postgres-database";
import { agentRunObservations, agentRuns, operationRuns } from "./schema";

/**
 * An approval decision, rejection or expiry decides its Operation Run before waking the
 * agent. Called in that same transaction, and when storing a pause: a decision may finish
 * before the worker has stored its wait. Locking the agent serializes both orders.
 */
export async function resumeAgentRunAfterApproval(
  tx: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; agentRunId: string }
): Promise<void> {
  const identity = and(
    eq(agentRuns.clientInstanceId, input.clientInstanceId),
    eq(agentRuns.id, input.agentRunId)
  );
  await lockAgentRunConversations(tx, input.clientInstanceId, [input.agentRunId]);
  const [run] = await tx.select().from(agentRuns).where(identity).for("update");
  if (run?.status !== "waiting_for_decision" || !run.resumeState?.waiting.length) return;
  const waiting = run.resumeState.waiting;
  const calls = await tx
    .select()
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        inArray(
          operationRuns.id,
          waiting.map((call) => call.operationRunId)
        )
      )
    );
  // Confirmations in the conversation have their own decision transaction. A timely
  // approval, or a confirmation given in the Inbox (OP-4b), resumes in the agent worker, which
  // executes the frozen call under the agent's lease.
  if (
    calls.length !== waiting.length ||
    calls.some(
      (call) =>
        !call.approvalRequestId ||
        call.status === "running" ||
        (call.status === "pending_approval" && call.decision?.mode !== "approved") ||
        (call.status === "pending_confirmation" && call.decision?.mode !== "confirmed")
    )
  )
    return;
  let sequence = run.lastSequence;
  for (const call of calls) {
    const waited = waiting.find((entry) => entry.operationRunId === call.id);
    if (!waited) continue;
    const decision = call.decision;
    const event: AgentRuntimeEvent = {
      type: "tool_decision_recorded",
      runId: asAgentRunId(run.id),
      sequence: ++sequence,
      createdAt: new Date().toISOString(),
      toolCallId: asToolCallId(waited.toolCallId),
      operationRunId: call.id,
      outcome:
        call.status === "expired"
          ? "expired"
          : decision?.mode === "approved" || decision?.mode === "confirmed"
            ? "confirmed"
            : "declined",
      ...(decision?.by ? { decidedBy: decision.by } : {}),
      ...(decision?.comment ? { reason: decision.comment } : {})
    };
    await tx.insert(agentRunObservations).values({
      clientInstanceId: run.clientInstanceId,
      runId: run.id,
      conversationId: run.conversationId,
      ownerUserId: run.ownerUserId,
      sequence: event.sequence,
      type: event.type,
      payload: event,
      createdAt: new Date(event.createdAt)
    });
  }
  await tx
    .update(agentRuns)
    .set({ status: "queued", lastSequence: sequence, updatedAt: sql`now()` })
    .where(identity);
  await enqueueJob(
    tx,
    executeAgentRunJob,
    { runId: asAgentRunId(run.id) },
    {
      ...agentRunJobOptions({
        ...run,
        id: asAgentRunId(run.id),
        clientInstanceId: asClientInstanceId(run.clientInstanceId)
      }),
      // The job that stored the pause may still be running. Its dedupe key must not consume
      // this wakeup; claims of the subject row still allow only one executor.
      dedupeKey: `${executeAgentRunJob.kind}:${run.id}:decision:${sequence}`
    }
  );
}
