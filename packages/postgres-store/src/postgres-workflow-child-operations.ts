import { countWorkflowFailures } from "./postgres-workflow-failure-counts";
import { and, asc, eq, sql } from "drizzle-orm";
import type { WorkflowRunsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { operationRuns } from "./schema/operationRuns";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";
import {
  runColumns,
  mapRun,
  mapPreview,
  previewOf,
  runIs,
  stepRunIs
} from "./postgres-workflow-run-mapping";

/**
 * Child lineage, output, and the waiting transitions of `workflow` steps and of `operation`
 * steps on an operation that ends later, used by the Workflow Runs store.
 */
export function childWorkflowRuns(
  db: PostgresConnection
): Pick<
  WorkflowRunsStore,
  | "lockDefinitionGraph"
  | "lockRunLinks"
  | "findRunByOperation"
  | "findChildRun"
  | "listChildRuns"
  | "readRunOutput"
  | "markChildWaiting"
  | "waitForOperation"
> {
  return {
    async lockDefinitionGraph(input) {
      const key = `workflow-definition-graph:${input.clientInstanceId}`;
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    },
    async lockRunLinks(input) {
      const key = `workflow-run-links:${input.clientInstanceId}`;
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    },
    async findRunByOperation(ref) {
      const [row] = await db
        .select({ ...runColumns, preview: previewOf(workflowRuns.output) })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.clientInstanceId, ref.clientInstanceId),
            eq(workflowRuns.operationRunId, ref.operationRunId)
          )
        );
      if (!row) return undefined;
      const counts = await countWorkflowFailures(db, {
        clientInstanceId: ref.clientInstanceId,
        runIds: [row.id]
      });
      return {
        ...mapRun(row),
        ...mapPreview(row.preview),
        failedDescendantCount: counts.get(row.id) ?? 0
      };
    },
    async findChildRun(ref) {
      const [row] = await db
        .select({ ...runColumns, preview: previewOf(workflowRuns.output) })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.clientInstanceId, ref.clientInstanceId),
            sql`${workflowRuns.parentStepRunId} = ${ref.id}`
          )
        );
      if (!row) return undefined;
      const counts = await countWorkflowFailures(db, {
        clientInstanceId: ref.clientInstanceId,
        runIds: [row.id]
      });
      return {
        ...mapRun(row),
        ...mapPreview(row.preview),
        failedDescendantCount: counts.get(row.id) ?? 0
      };
    },
    async listChildRuns(ref) {
      const rows = await db
        .select({ ...runColumns, preview: previewOf(workflowRuns.output) })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.clientInstanceId, ref.clientInstanceId),
            eq(workflowRuns.parentRunId, ref.id)
          )
        )
        .orderBy(asc(workflowRuns.createdAt), asc(workflowRuns.id));
      const counts = await countWorkflowFailures(db, {
        clientInstanceId: ref.clientInstanceId,
        runIds: rows.map((row) => row.id)
      });
      return rows.map((row) => ({
        ...mapRun(row),
        ...mapPreview(row.preview),
        failedDescendantCount: counts.get(row.id) ?? 0
      }));
    },
    async readRunOutput(ref) {
      const [row] = await db
        .select({ output: workflowRuns.output })
        .from(workflowRuns)
        .where(runIs(ref));
      return row?.output ?? undefined;
    },
    async markChildWaiting(ref) {
      await db
        .update(workflowStepRuns)
        .set({
          status: "waiting",
          operationRunId: ref.operationRunId,
          effect: ref.call?.effect,
          source: ref.call?.source,
          target: ref.call?.target
        })
        .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "running")));
    },
    async waitForOperation(ref) {
      // The share lock waits for an end that is being written and holds off one that has
      // not started: the end then reads this step as waiting and wakes it.
      const [call] = await db
        .select({ status: operationRuns.status })
        .from(operationRuns)
        .where(
          and(
            eq(operationRuns.clientInstanceId, ref.clientInstanceId),
            eq(operationRuns.id, ref.operationRunId)
          )
        )
        .for("share");
      if (call?.status !== "running") return false;
      const waiting = await db
        .update(workflowStepRuns)
        .set({
          status: "waiting",
          operationRunId: ref.operationRunId,
          effect: ref.call?.effect,
          source: ref.call?.source,
          target: ref.call?.target
        })
        .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "running")))
        .returning({ id: workflowStepRuns.id });
      return waiting.length > 0;
    }
  };
}
