-- A run key is held per starter: the person or Service Principal, and the API key a person started the run with. Another starter's run with the same key no longer answers a start.
-- The new index comes first, so while both exist the old, stricter one still holds.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_active_starter_run_key_idx" ON "workflow_runs" USING btree ("client_instance_id","workflow","mode",("started_by" ->> 'kind'),("started_by" ->> 'id'),coalesce("started_by" -> 'delegatedActor' ->> 'kind', ''),coalesce("started_by" -> 'delegatedActor' ->> 'id', ''),"run_key") WHERE "workflow_runs"."run_key" is not null and "workflow_runs"."status" not in ('failed', 'cancelled', 'limit_reached', 'continued');--> statement-breakpoint
-- Workflow runs did not exist in v0.6.3. A release before this one keeps working: it inserts under the new index and, after a conflict, reads a holder of the key without asking the starter, so until it drains it may answer another starter's run where two share a key.
-- contract-after: v0.6.3
DROP INDEX CONCURRENTLY IF EXISTS "workflow_runs_active_run_key_idx";
