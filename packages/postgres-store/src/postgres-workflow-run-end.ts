import { failedItemCount } from "./postgres-workflow-item-counts";
import { and, sql } from "drizzle-orm";
import type { WorkflowRunsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { notEnded, runIs } from "./postgres-workflow-run-mapping";
import { workflowRuns } from "./schema/workflowRuns";

/**
 * A known item-count answer proves a write handled zero items. Unknown results stay visible.
 * Failed items and skipped/unchanged items are work too. This reads counters only and neither
 * returns nor copies step values. The run's lock serializes this with every step completion.
 */
const noHandledWrite = sql`not exists (
  select 1 from workflow_step_runs step
  where step.client_instance_id = ${workflowRuns.clientInstanceId}
    and step.run_id = ${workflowRuns.id}
    and (
      step.status = 'failed'
      or (step.step_type = 'agent' and step.status = 'done')
      or (step.effect = 'changing' and step.status = 'done' and not coalesce(
        jsonb_typeof(step.output->'value') = 'object'
        and (step.output->'value') ?| array['accepted', 'done', 'failed', 'withdrawn', 'inserted', 'skipped', 'updated', 'deleted', 'loaded']
        and not exists (
          select 1 from jsonb_each(
            case when jsonb_typeof(step.output->'value') = 'object'
              then step.output->'value' else '{}'::jsonb end
          ) field
          where case
            when field.key = 'table' then jsonb_typeof(field.value) <> 'string'
            when field.key = 'failures' then
              not coalesce(field.value->'rowCount' = '0'::jsonb, false)
            when field.key in ('accepted', 'done', 'failed', 'withdrawn', 'inserted', 'skipped', 'updated', 'deleted', 'loaded') then
              field.value <> '0'::jsonb
            else true
          end
        ), false))
      or exists (
        select 1 from workflow_runs child
        where child.client_instance_id = step.client_instance_id
          and (child.parent_step_run_id = step.id or child.id = step.linked_run_id)
          and not child.empty
      )
    )
)`;

/** Persist the empty marker with the successful end; pruning cannot later change history. */
export async function endWorkflowRun(
  db: PostgresConnection,
  ref: Parameters<WorkflowRunsStore["endRun"]>[0]
): Promise<boolean> {
  const ended = await db
    .update(workflowRuns)
    .set({
      status: ref.status,
      // Count an item once even when several of its steps failed. This runs behind the run
      // lock, once at its end, and survives pruning without copying any step values.
      // Carry the predecessor's rollup through the Lauf, even when older parts are not loaded.
      // The predecessor lookup uses its primary key; no history or step payload is scanned.
      failedItemCount,
      empty:
        ref.status === "done"
          ? sql`${workflowRuns.mode} = 'live' and coalesce(${workflowRuns.definition}->>'kind' = 'data', false) and ${noHandledWrite}`
          : false,
      finishedAt: new Date(ref.finishedAt),
      output: ref.output === undefined ? null : { value: ref.output },
      error: ref.error ?? null,
      ...(ref.status === "cancelled"
        ? { cancelledBy: ref.cancelledBy ?? null, cancelledAt: new Date(ref.finishedAt) }
        : {})
    })
    .where(and(runIs(ref), notEnded(workflowRuns.status)))
    .returning({ id: workflowRuns.id });
  return ended.length > 0;
}
