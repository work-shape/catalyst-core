import { wakeWorkflowAgentStep } from "./postgres-workflow-agent-wake";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  agentRunJobOptions,
  asAgentRunId,
  asClientInstanceId,
  executeAgentRunJob,
  type AgentRuntimeEvent,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { enqueueJob } from "./jobs/store";
import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import type { PostgresConnection } from "./postgres-database";
import { withdrawUnclaimedWorkspaceCommandsOfRuns } from "./postgres-execution-workspace-operations";
import { agentRunObservations, agentRuns, conversationFollowUps } from "./schema";

// What ties a subagent's end to its parent run (CR-1). Lock order, everywhere: the parent's
// root conversation, the parent run, the child's thread, the child run. Every transaction that
// ends an Agent Run locks the parents of the runs it ends first, and before it commits it asks
// the open children of each run it ended to cancel, and wakes each parent whose last child
// ended while it waited for its subagents.

/** The reason a subagent that its parent's end cancelled carries. */
const PARENT_ENDED_CANCELLATION_REASON = "The run that started this subagent ended.";

/**
 * Locks the parent runs of `runIds`, after their conversations, in id order. Called first in a
 * transaction that may end one of `runIds`. A run without a parent locks nothing here.
 */
export async function lockParentRunsOf(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  runIds: readonly string[]
): Promise<void> {
  if (runIds.length === 0) return;
  // The parent of a run never changes, so it is read without a lock.
  const children = await tx
    .select({ parentRunId: agentRuns.parentRunId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, clientInstanceId),
        inArray(agentRuns.id, [...runIds]),
        isNotNull(agentRuns.parentRunId)
      )
    );
  const parentIds = [
    ...new Set(children.flatMap((child) => (child.parentRunId ? [child.parentRunId] : [])))
  ].sort();
  if (parentIds.length === 0) return;
  await lockAgentRunConversations(tx, clientInstanceId, parentIds);
  await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.clientInstanceId, clientInstanceId), inArray(agentRuns.id, parentIds)))
    .orderBy(asc(agentRuns.id))
    .for("update");
}

/**
 * What follows the end of runs, in the transaction that ended them: each open child of an ended
 * run is asked to cancel, and each parent of an ended run that waits for its subagents is queued
 * again with its job once none of them is open. The parents were locked by `lockParentRunsOf`.
 */
export async function settleEndedAgentRuns(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  ended: readonly { id: string; parentRunId: string | null }[],
  at: Date
): Promise<{ queuedParents: number }> {
  if (ended.length === 0) return { queuedParents: 0 };
  const workflowAgents = await tx
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, clientInstanceId),
        inArray(
          agentRuns.id,
          ended.map((run) => run.id)
        ),
        isNotNull(agentRuns.workflowStepRunId)
      )
    );
  for (const child of workflowAgents) await wakeWorkflowAgentStep(tx, child);
  await releaseUntakenSteers(
    tx,
    clientInstanceId,
    ended.map((run) => run.id),
    at
  );
  await cancelOpenChildren(
    tx,
    clientInstanceId,
    ended.map((run) => run.id),
    at
  );
  const parentIds = [
    ...new Set(ended.flatMap((run) => (run.parentRunId ? [run.parentRunId] : [])))
  ].sort();
  let queuedParents = 0;
  for (const parentId of parentIds) {
    if (await wakeParentIfDone(tx, clientInstanceId, parentId)) queuedParents += 1;
  }
  return { queuedParents };
}

/**
 * A steer an ended run did not take in becomes a queued follow-up, whichever way the run ended:
 * it is never lost (FU-2). The conversations are read first so the update uses the pending
 * index. A run waiting for a decision has not ended; its steers stay for its resume.
 */
async function releaseUntakenSteers(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  runIds: readonly string[],
  at: Date
): Promise<void> {
  const conversations = await tx
    .selectDistinct({ id: agentRuns.conversationId })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.clientInstanceId, clientInstanceId), inArray(agentRuns.id, [...runIds]))
    );
  if (conversations.length === 0) return;
  await tx
    .update(conversationFollowUps)
    .set({ mode: "queue", dispatchedRunId: null, updatedAt: at })
    .where(
      and(
        eq(conversationFollowUps.clientInstanceId, clientInstanceId),
        inArray(
          conversationFollowUps.conversationId,
          conversations.map((conversation) => conversation.id)
        ),
        eq(conversationFollowUps.status, "pending"),
        eq(conversationFollowUps.mode, "steer"),
        inArray(conversationFollowUps.dispatchedRunId, [...runIds])
      )
    );
}

/** Whether a run has a subagent that has not ended. */
export async function hasOpenChildren(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  parentRunId: string
): Promise<boolean> {
  const [open] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, clientInstanceId),
        eq(agentRuns.parentRunId, parentRunId),
        inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES)
      )
    )
    .limit(1);
  return open !== undefined;
}

/**
 * Queues a parent again with a job of its own. The job that stored its pause may still run
 * under the run's own dedupe key, so this wake takes a key of its own; the claim of the run row
 * still lets only one executor through.
 */
export async function enqueueSubagentWake(
  tx: PostgresConnection,
  run: { id: string; clientInstanceId: string; correlationId: string; lastSequence: number }
): Promise<void> {
  await enqueueJob(
    tx,
    executeAgentRunJob,
    { runId: asAgentRunId(run.id) },
    {
      ...agentRunJobOptions({
        id: asAgentRunId(run.id),
        clientInstanceId: asClientInstanceId(run.clientInstanceId),
        correlationId: run.correlationId
      }),
      dedupeKey: `${executeAgentRunJob.kind}:${run.id}:subagents:${run.lastSequence}`
    }
  );
}

async function wakeParentIfDone(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  parentRunId: string
): Promise<boolean> {
  const [parent] = await tx
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.clientInstanceId, clientInstanceId), eq(agentRuns.id, parentRunId)))
    .limit(1);
  if (parent?.status !== "waiting_for_subagents") return false;
  if (await hasOpenChildren(tx, clientInstanceId, parentRunId)) return false;
  await tx
    .update(agentRuns)
    .set({ status: "queued", updatedAt: sql`now()` })
    .where(and(eq(agentRuns.clientInstanceId, clientInstanceId), eq(agentRuns.id, parentRunId)));
  await enqueueSubagentWake(tx, parent);
  return true;
}

/**
 * Asks each open child of `parentRunIds` to cancel: one that no worker holds ends at once, a
 * running one when its worker reads the request. The children's threads are locked before the
 * children, in id order.
 */
async function cancelOpenChildren(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  parentRunIds: readonly string[],
  at: Date
): Promise<void> {
  const open = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, clientInstanceId),
        inArray(agentRuns.parentRunId, [...parentRunIds]),
        inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES)
      )
    );
  if (open.length === 0) return;
  const childIds = open.map((child) => child.id).sort();
  await lockAgentRunConversations(tx, clientInstanceId, childIds);
  const children = await tx
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.clientInstanceId, clientInstanceId), inArray(agentRuns.id, childIds)))
    .orderBy(asc(agentRuns.id))
    .for("update");
  const ended: string[] = [];
  for (const child of children) {
    if (child.status === "running") {
      await tx
        .update(agentRuns)
        .set({
          status: "cancelling",
          cancellationRequestedAt: at,
          cancellationReason: PARENT_ENDED_CANCELLATION_REASON,
          updatedAt: at
        })
        .where(and(eq(agentRuns.clientInstanceId, clientInstanceId), eq(agentRuns.id, child.id)));
      continue;
    }
    // A child never waits for a decision or for subagents of its own; a queued one has not
    // been claimed, so it ends here. One already cancelling ends when its worker stops.
    if (child.status !== "queued") continue;
    const event: AgentRuntimeEvent = {
      type: "run_cancelled",
      runId: asAgentRunId(child.id),
      sequence: child.lastSequence + 1,
      createdAt: at.toISOString(),
      reason: PARENT_ENDED_CANCELLATION_REASON
    };
    await tx
      .update(agentRuns)
      .set({
        status: "cancelled",
        cancellationRequestedAt: at,
        cancellationReason: PARENT_ENDED_CANCELLATION_REASON,
        cancelledAt: at,
        updatedAt: at,
        lastSequence: event.sequence,
        resumeState: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null
      })
      .where(and(eq(agentRuns.clientInstanceId, clientInstanceId), eq(agentRuns.id, child.id)));
    await tx.insert(agentRunObservations).values({
      clientInstanceId: child.clientInstanceId,
      runId: child.id,
      conversationId: child.conversationId,
      ownerUserId: child.ownerUserId,
      sequence: event.sequence,
      type: event.type,
      payload: event,
      createdAt: at
    });
    ended.push(child.id);
  }
  if (ended.length > 0)
    await withdrawUnclaimedWorkspaceCommandsOfRuns(tx, {
      clientInstanceId,
      runIds: ended.map(asAgentRunId)
    });
}
