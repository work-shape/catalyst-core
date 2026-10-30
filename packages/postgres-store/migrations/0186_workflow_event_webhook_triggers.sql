-- EW-4: the webhook and platform_event triggers. `workflow_webhook_deliveries` keeps one row per
-- nonce a Workflow's webhook accepted, for as long as a request with it could still pass its
-- timestamp check: replays are refused and the trigger's rate is counted from it. It holds no
-- body and no header beside the nonce. `workflow_runs.trigger_event` is the platform event that
-- started a run: ids, names and counts. A nullable column without a default adds no rewrite;
-- its unique index is built without blocking writes in 0187.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "workflow_webhook_deliveries" (
	"client_instance_id" text NOT NULL,
	"workflow_asset_id" text NOT NULL,
	"nonce" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_webhook_deliveries_pk" PRIMARY KEY("workflow_asset_id","nonce")
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "trigger_event" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_webhook_deliveries" ADD CONSTRAINT "workflow_webhook_deliveries_workflow_asset_id_config_assets_id_fk" FOREIGN KEY ("workflow_asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_webhook_deliveries_received_idx" ON "workflow_webhook_deliveries" USING btree ("workflow_asset_id","received_at");
