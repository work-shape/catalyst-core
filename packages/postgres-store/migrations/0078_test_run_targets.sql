-- Expand (ADR-0031, EW-5t): where the call of each step run went, and on a test run the steps
-- a "Run live once" switch made live for the whole run. A row written by a release that does
-- not know the columns has neither; its Operation Runs still say where each call went.
ALTER TABLE "workflow_runs" ADD COLUMN "live_steps" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "target" text;