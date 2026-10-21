-- A new table, empty: every agent stays usable by everyone where it is available (AGENT-USE-1).
-- Its foreign key locks config_assets briefly; a busy one fails the migration instead of
-- holding up chat.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "agent_use_limits" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_use_limits" ADD CONSTRAINT "agent_use_limits_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_use_limits_client_idx" ON "agent_use_limits" USING btree ("client_instance_id");