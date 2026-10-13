ALTER TABLE "workflow_step_runs" ADD COLUMN "staged" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "code_outcome" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "log" jsonb;