-- The retention job repairs older marked rows through the same bounded queue as new prunes.
-- Keep the previous release's index while its workers drain.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_retention_idx" ON "workflow_runs" USING btree ("client_instance_id","finished_at","id") WHERE "workflow_runs"."data_prune_version" < 1 and "workflow_runs"."finished_at" is not null;
