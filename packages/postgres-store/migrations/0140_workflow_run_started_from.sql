-- A nullable column without a default adds no rewrite; the brief lock still waits at most 5s.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "started_from" jsonb;
