import { sql } from "drizzle-orm";
import { workflowRuns } from "./schema/workflowRuns";

/** Distinct failed loop items in this part, plus the predecessor's persisted Lauf rollup. */
export const failedItemCount = sql`(
        select count(*)::integer from (
          select step.container_step_run_id, step.iteration
          from workflow_step_runs step
          where step.client_instance_id = ${workflowRuns.clientInstanceId}
            and step.run_id = ${workflowRuns.id}
            and step.container_step_run_id is not null
            and step.iteration is not null and step.status = 'failed'
          group by step.container_step_run_id, step.iteration
        ) failed_items
      ) + coalesce((
        select previous.failed_item_count from workflow_runs previous
        where previous.client_instance_id = ${workflowRuns.clientInstanceId}
          and previous.id = ${workflowRuns.continuation}->>'previousRunId'
      ), 0)`;
