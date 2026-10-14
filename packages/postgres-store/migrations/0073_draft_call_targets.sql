-- Expand (ADR-0031): where each call went, and "Run live once" on a draft. A run written by a
-- release that does not know the column is `live`, which every call of that release is. The
-- check is added without a scan of the table; the next migration validates it.
CREATE TABLE "live_once_switches" (
	"client_instance_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"asset_kind" text NOT NULL,
	"asset_name" text NOT NULL,
	"part" text NOT NULL,
	"revision_id" text NOT NULL,
	"switched_by_id" text NOT NULL,
	"switched_by_label" text NOT NULL,
	"switched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "live_once_switches_pk" PRIMARY KEY("asset_id","part")
);
--> statement-breakpoint
ALTER TABLE "operation_runs" ADD COLUMN "target" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "live_once_switches" ADD CONSTRAINT "live_once_switches_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_runs" ADD CONSTRAINT "operation_runs_target_check" CHECK ("operation_runs"."target" in ('live', 'test', 'dry_run')) NOT VALID;