-- LU-3: the Usage page counts the conversations, Agent Runs and Workflow Runs of a period, and
-- the Usage tab of a shared workspace sums its members' month from the workspace's usage
-- events. The deletion of a workspace finds its events by that index too, so it replaces the
-- one on the workspace alone.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_runs_client_started_idx" ON "agent_runs" USING btree ("client_instance_id","started_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_client_created_idx" ON "conversations" USING btree ("client_instance_id","created_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_client_created_idx" ON "workflow_runs" USING btree ("client_instance_id","created_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "model_usage_events_workspace_created_idx" ON "model_usage_events" USING btree ("collaboration_workspace_id","created_at") WHERE "model_usage_events"."collaboration_workspace_id" is not null;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "model_usage_events_workspace_idx";
