CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_operation_idx" ON "workflow_runs" USING btree ("client_instance_id","operation_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_parent_step_idx" ON "workflow_runs" USING btree ("client_instance_id","parent_step_run_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_parent_idx" ON "workflow_runs" USING btree ("client_instance_id","parent_run_id");--> statement-breakpoint
