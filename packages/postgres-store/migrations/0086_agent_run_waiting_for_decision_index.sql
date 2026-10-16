DROP INDEX CONCURRENTLY IF EXISTS "agent_runs_active_conversation_idx";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "agent_runs_active_conversation_idx" ON "agent_runs" USING btree ("client_instance_id","conversation_id") WHERE "agent_runs"."status" in ('queued', 'running', 'waiting_for_decision', 'cancelling');
