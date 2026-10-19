import { workflowStepJobKind, asClientInstanceId } from "@work-shape/catalyst-core";
import { and, eq, sql } from "drizzle-orm";
import { enqueueJob } from "./jobs/store";
import type { PostgresConnection } from "./postgres-database";
import { workflowRuns, workflowStepRuns } from "./schema";

/** Agent transactions never lock their Workflow: its own step job recalculates the wait. */
export async function wakeWorkflowAgentStep(
  tx: PostgresConnection,
  run: {
    clientInstanceId: string;
    workflowStepRunId: string | null;
    lastSequence: number;
    correlationId: string;
  }
): Promise<void> {
  if (!run.workflowStepRunId) return;
  const [owner] = await tx
    .select({ id: workflowRuns.id, limits: workflowRuns.limits })
    .from(workflowRuns)
    .innerJoin(
      workflowStepRuns,
      and(
        eq(workflowRuns.id, workflowStepRuns.runId),
        eq(workflowRuns.clientInstanceId, workflowStepRuns.clientInstanceId)
      )
    )
    .where(
      and(
        sql`${workflowStepRuns.id} = ${run.workflowStepRunId}`,
        eq(workflowStepRuns.clientInstanceId, asClientInstanceId(run.clientInstanceId))
      )
    )
    .limit(1);
  if (!owner) return;
  await enqueueJob(
    tx,
    workflowStepJobKind,
    { stepRunId: run.workflowStepRunId },
    {
      clientInstanceId: asClientInstanceId(run.clientInstanceId),
      subject: run.workflowStepRunId,
      dedupeKey: `${workflowStepJobKind.kind}:${run.workflowStepRunId}:agent:${run.lastSequence}`,
      ...(owner.limits.concurrency
        ? {
            concurrencyKey: owner.limits.concurrency.key,
            concurrencyLimit: owner.limits.concurrency.slots
          }
        : { concurrencyKey: owner.id }),
      correlationId: run.correlationId
    }
  );
}
