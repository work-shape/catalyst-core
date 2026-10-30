-- EW-4: one run per Workflow per platform event, whichever worker dispatches it and however
-- often. Built without blocking writes; every existing run has no trigger event.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_trigger_event_idx" ON "workflow_runs" USING btree ("client_instance_id","workflow",("trigger_event" ->> 'id')) WHERE "workflow_runs"."trigger_event" is not null;
