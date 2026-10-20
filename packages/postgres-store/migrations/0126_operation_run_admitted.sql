-- Nullable metadata-only addition needs no backfill; repeatable after an interrupted index build.
ALTER TABLE "operation_runs" ADD COLUMN IF NOT EXISTS "admitted_at" timestamptz;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "operation_runs_admitted_idx" ON "operation_runs" USING btree ("client_instance_id","operation","admitted_at") WHERE "operation_runs"."admitted_at" is not null;
