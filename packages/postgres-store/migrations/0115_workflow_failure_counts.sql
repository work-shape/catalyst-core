-- Nullable metadata-only additions need no backfill; repeatable after an interrupted index build.
ALTER TABLE "product_users" ADD COLUMN IF NOT EXISTS "locale" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "failed_item_count" integer;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_failures_idx" ON "workflow_runs" USING btree ("client_instance_id","root_run_id") WHERE "workflow_runs"."status" in ('failed', 'limit_reached') or "workflow_runs"."failed_item_count" > 0;
