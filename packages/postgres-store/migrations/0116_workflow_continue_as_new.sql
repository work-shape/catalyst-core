-- Workflow runs did not exist in v0.6.3. Earlier release candidates cannot read continued.
-- Fail promptly rather than queue a table lock behind a busy worker.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_status_check";--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "labels" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "continuation" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_status_check" CHECK ("workflow_runs"."status" in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'limit_reached', 'continued')) NOT VALID;
