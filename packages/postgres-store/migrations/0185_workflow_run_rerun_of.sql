-- EW-11: a run re-run from a chosen step names the run it re-runs, the step and the steps whose
-- outputs it reused. A nullable column without a default adds no rewrite.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "rerun_of" jsonb;
