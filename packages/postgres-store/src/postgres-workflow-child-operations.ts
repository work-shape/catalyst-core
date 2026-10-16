import { and, asc, eq, sql } from "drizzle-orm";
import type { WorkflowRunsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";
import {
  runColumns,
  mapRun,
  mapPreview,
  previewOf,
  runIs,
  stepRunIs
} from "./postgres-workflow-run-mapping";

/** Child lineage, output, and waiting transitions used by the Workflow Runs store. */
export function childWorkflowRuns(
  db: PostgresConnection
): Pick<
  WorkflowRunsStore,
  | "lockDefinitionGraph"
  | "findRunByOperation"
  | "findChildRun"
  | "listChildRuns"
  | "readRunOutput"
  | "markChildWaiting"
> {
  return {
    async lockDefinitionGraph(input) {
      const key = `workflow-definition-graph:${input.clientInstanceId}`;
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
      return row ? { ...mapRun(row), ...mapPreview(row.preview) } : undefined;
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
      return row ? { ...mapRun(row), ...mapPreview(row.preview) } : undefined;
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
      return rows.map((row) => ({ ...mapRun(row), ...mapPreview(row.preview) }));
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
    }
  };
}
