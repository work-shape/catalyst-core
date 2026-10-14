-- EW-5t (ADR-0031): a "Run live once" switch belongs to the person who set it; a test run that
-- takes one keeps it to its end in `live_once_runs`, so its owner can set a new switch for the
-- next run meanwhile. Every step run records where its call went and, in a test run, whether a
-- run of the published revision would ask for an approval there.
CREATE TABLE "live_once_runs" (
	"client_instance_id" text NOT NULL,
	"workflow_run_id" text NOT NULL,
	"part" text NOT NULL,
	"asset_id" text NOT NULL,
	"asset_kind" text NOT NULL,
	"asset_name" text NOT NULL,
	"revision_id" text NOT NULL,
	"switched_by_id" text NOT NULL,
	"switched_by_label" text NOT NULL,
	"switched_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "live_once_runs_pk" PRIMARY KEY("workflow_run_id","part")
);
--> statement-breakpoint
-- The key of `live_once_switches` gains the owner. The table came with 0073, which no release
-- carries (v0.6.4 and earlier never had it), so no supported release depends on the old key.
-- contract-after: v0.6.3
ALTER TABLE "live_once_switches" DROP CONSTRAINT "live_once_switches_pk";--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "live_once_switches" ADD CONSTRAINT "live_once_switches_owner_pk" PRIMARY KEY("asset_id","part","switched_by_id");--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "published_would_ask" text;--> statement-breakpoint
ALTER TABLE "live_once_runs" ADD CONSTRAINT "live_once_runs_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_once_runs_owner_idx" ON "live_once_runs" USING btree ("asset_id","switched_by_id","part","used_at");--> statement-breakpoint
-- The checks are added without a scan and validated at once: both columns are new and empty.
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_target_check" CHECK ("workflow_step_runs"."target" is null or "workflow_step_runs"."target" in ('live', 'test', 'dry_run')) NOT VALID;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_published_would_ask_check" CHECK ("workflow_step_runs"."published_would_ask" is null or "workflow_step_runs"."published_would_ask" = 'approval') NOT VALID;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" VALIDATE CONSTRAINT "workflow_step_runs_target_check";--> statement-breakpoint
ALTER TABLE "workflow_step_runs" VALIDATE CONSTRAINT "workflow_step_runs_published_would_ask_check";
