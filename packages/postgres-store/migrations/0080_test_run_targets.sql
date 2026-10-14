-- EW-5t (ADR-0031): a "Run live once" switch belongs to the person who set it and is bound to
-- the test run that used it; every step run records where its call went and, in a test run,
-- whether a run of the published revision would ask for an approval there.
-- The key of `live_once_switches` gains the owner. The table came with 0073, which no release
-- carries (v0.6.4 and earlier never had it), so no supported release depends on the old key.
-- contract-after: v0.6.3
ALTER TABLE "live_once_switches" DROP CONSTRAINT "live_once_switches_pk";--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "live_once_switches" ADD CONSTRAINT "live_once_switches_owner_pk" PRIMARY KEY("asset_id","part","switched_by_id");--> statement-breakpoint
ALTER TABLE "live_once_switches" ADD COLUMN "used_by_run_id" text;--> statement-breakpoint
ALTER TABLE "live_once_switches" ADD COLUMN "used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "published_would_ask" text;--> statement-breakpoint
-- Both columns are new and hold no value yet, so the checks are added without a scan: they
-- hold for every row a release writes from now on.
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_target_check" CHECK ("workflow_step_runs"."target" is null or "workflow_step_runs"."target" in ('live', 'test', 'dry_run')) NOT VALID;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_published_would_ask_check" CHECK ("workflow_step_runs"."published_would_ask" is null or "workflow_step_runs"."published_would_ask" = 'approval') NOT VALID;
