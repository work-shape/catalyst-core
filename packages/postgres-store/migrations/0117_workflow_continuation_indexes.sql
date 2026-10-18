-- Workflow runs did not exist in v0.6.3. Earlier release candidates cannot resume a continued child.
-- contract-after: v0.6.3
DROP INDEX CONCURRENTLY IF EXISTS "workflow_runs_parent_step_idx";--> statement-breakpoint
-- contract-after: v0.6.3
DROP INDEX CONCURRENTLY IF EXISTS "workflow_runs_run_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_parent_step_idx" ON "workflow_runs" USING btree ("client_instance_id","parent_step_run_id") WHERE "workflow_runs"."status" <> 'continued';--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_run_key_idx" ON "workflow_runs" USING btree ("client_instance_id","workflow","mode","run_key") WHERE "workflow_runs"."run_key" is not null and "workflow_runs"."status" not in ('failed', 'cancelled', 'limit_reached', 'continued');
