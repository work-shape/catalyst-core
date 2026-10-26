-- Retention version 3 (tool results, settled requests and unremoved file copies in run threads). A query of the previous release's workers, version < 2, is answered from the new indexes too.
DROP INDEX CONCURRENTLY IF EXISTS "workflow_runs_retention_idx";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "workflow_runs_retention_repair_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_retention_idx" ON "workflow_runs" USING btree ("client_instance_id","finished_at","id") WHERE "workflow_runs"."data_prune_version" < 3 and "workflow_runs"."data_pruned_at" is null and "workflow_runs"."finished_at" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_retention_repair_idx" ON "workflow_runs" USING btree ("client_instance_id","finished_at","id") WHERE "workflow_runs"."data_prune_version" < 3 and "workflow_runs"."data_pruned_at" is not null and "workflow_runs"."finished_at" is not null;
