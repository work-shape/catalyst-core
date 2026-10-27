-- WF-OUT: the Workflow run whose operation step or agent's tool started a run, kept on every
-- continuation, so the reach walk finds it after a continue-as-new and after the Operation Run
-- of the call is pruned. Nullable, no default: no row is rewritten, and runs opened before it
-- read their starter from their first history's Operation Run as before. No backfill. The
-- column locks workflow_runs briefly, which every worker reads; a busy table fails the
-- migration instead of holding up the engine.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "starter_run_id" text;
