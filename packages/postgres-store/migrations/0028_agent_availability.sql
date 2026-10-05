CREATE TABLE "config_asset_availability" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"mode" text NOT NULL,
	"personal_workspaces" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "config_asset_availability_mode_check" CHECK ("config_asset_availability"."mode" in ('all', 'selected'))
);
--> statement-breakpoint
CREATE TABLE "config_asset_workspace_availability" (
	"asset_id" text NOT NULL,
	"collaboration_workspace_id" text NOT NULL,
	CONSTRAINT "config_asset_workspace_availability_pk" PRIMARY KEY("asset_id","collaboration_workspace_id")
);
--> statement-breakpoint
ALTER TABLE "config_asset_availability" ADD CONSTRAINT "config_asset_availability_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_asset_workspace_availability" ADD CONSTRAINT "config_asset_workspace_availability_asset_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_asset_availability"("asset_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_asset_workspace_availability" ADD CONSTRAINT "config_asset_workspace_availability_workspace_fk" FOREIGN KEY ("collaboration_workspace_id") REFERENCES "public"."collaboration_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_asset_availability_client_idx" ON "config_asset_availability" USING btree ("client_instance_id");--> statement-breakpoint
CREATE INDEX "config_asset_workspace_availability_workspace_idx" ON "config_asset_workspace_availability" USING btree ("collaboration_workspace_id");--> statement-breakpoint
-- Hand-edited: a missing availability row hides the agent, so every active agent that exists
-- before this migration is backfilled to 'all' and keeps its current audience.
INSERT INTO "config_asset_availability" ("asset_id", "client_instance_id", "mode", "personal_workspaces", "updated_at")
SELECT "id", "client_instance_id", 'all', false, now()
FROM "config_assets"
WHERE "kind" = 'agent' AND "status" = 'active';
