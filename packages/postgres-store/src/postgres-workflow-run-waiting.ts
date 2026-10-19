import { sql } from "drizzle-orm";
import type { WorkflowRunsStore } from "@work-shape/catalyst-core";

type Input<Method extends keyof WorkflowRunsStore> = Parameters<WorkflowRunsStore[Method]>[0];

/**
 * Whether every open step run of the run waits for something outside it. A step run that is
 * queued or running is work, and so is a code step whose script runs; a loop's own step run
 * waits for its items, which count by themselves. A `workflow` step waits outside the run
 * only while its child waits as well. A run linked by key is independently owned and
 * budgeted, so waiting for it is external regardless of whether that run is working.
 */
export const runIsWaiting = (ref: Input<"markRunWaiting">) => sql`exists (
    select 1 from workflow_step_runs waiting
    where waiting.client_instance_id = ${ref.clientInstanceId}
      and waiting.run_id = ${ref.id}
      and waiting.status = 'waiting'
      and (waiting.step_type in ('operation', 'workflow') or (waiting.step_type = 'agent' and exists (
        select 1 from agent_runs agent where agent.client_instance_id = waiting.client_instance_id
          and agent.workflow_step_run_id = waiting.id and agent.status = 'waiting_for_decision'
      )))
  ) and not exists (
    select 1 from workflow_step_runs working
    where working.client_instance_id = ${ref.clientInstanceId}
      and working.run_id = ${ref.id}
      and (
        working.status in ('queued', 'running')
        or (working.status = 'waiting' and working.step_type not in ('operation', 'workflow', 'loop', 'agent'))
        or (working.status = 'waiting' and working.step_type = 'agent' and not exists (
          select 1 from agent_runs agent where agent.client_instance_id = working.client_instance_id
            and agent.workflow_step_run_id = working.id and agent.status = 'waiting_for_decision'
        ))
        or (working.status = 'waiting' and working.step_type = 'workflow'
          and working.linked_run_id is null and not exists (
          select 1 from workflow_runs child
          where child.client_instance_id = working.client_instance_id
            and child.parent_step_run_id = working.id
            and child.waiting_since is not null
            and child.status in ('queued', 'running', 'waiting')
        ))
      )
  )`;
