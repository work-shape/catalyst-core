-- EW-10: a person's pinned step outputs on a Workflow's draft. A pin names the run whose output it
-- uses and holds no value. A test run records the pins it took in `workflow_runs.pinned_steps`.
CREATE TABLE "workflow_step_pins" (
	"client_instance_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"step" text NOT NULL,
	"pinned_by" text NOT NULL,
	"source_run_id" text NOT NULL,
	"step_hash" text NOT NULL,
	"pinned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_step_pins_pk" PRIMARY KEY("asset_id","pinned_by","step")
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "pinned_steps" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_step_pins" ADD CONSTRAINT "workflow_step_pins_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_pins" ADD CONSTRAINT "workflow_step_pins_source_run_id_workflow_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_step_pins_source_run_idx" ON "workflow_step_pins" USING btree ("source_run_id");
