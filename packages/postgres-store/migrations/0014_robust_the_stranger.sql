CREATE TABLE "config_asset_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"revision" integer NOT NULL,
	"operation" text NOT NULL,
	"config" jsonb,
	"actor" jsonb,
	"global_version" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_asset_state" (
	"client_instance_id" text PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"default_agent_name" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"active_revision_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_asset_revisions" ADD CONSTRAINT "config_asset_revisions_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "config_asset_revisions_asset_revision_idx" ON "config_asset_revisions" USING btree ("asset_id","revision");--> statement-breakpoint
CREATE INDEX "config_asset_revisions_client_asset_revision_idx" ON "config_asset_revisions" USING btree ("client_instance_id","asset_id","revision" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "config_assets_client_kind_name_idx" ON "config_assets" USING btree ("client_instance_id","kind","name");