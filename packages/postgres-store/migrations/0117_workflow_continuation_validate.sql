-- Validate separately so the scan does not hold the expansion's exclusive table lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "workflow_runs" VALIDATE CONSTRAINT "workflow_runs_status_check";
