-- Workflow runs did not exist in v0.6.3. Earlier release candidates cannot read continued.
-- contract-after: v0.6.3
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_status_check";--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "labels" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "continuation" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_status_check" CHECK ("workflow_runs"."status" in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'limit_reached', 'continued')) NOT VALID;--> statement-breakpoint
ALTER TABLE "workflow_runs" VALIDATE CONSTRAINT "workflow_runs_status_check";
