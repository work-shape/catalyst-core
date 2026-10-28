-- Projects (PRJ-1): the audience of each project asset, and the project a chat is in. A
-- nullable column without a default adds no rewrite. The key and the check are added without
-- reading the table under the brief lock, then validated without blocking writes; every
-- existing row holds null.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "projects" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"audience" text NOT NULL,
	"audience_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "projects_audience_check" CHECK ("projects"."audience" in ('workspace', 'private'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_config_assets_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."config_assets"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_chat_check" CHECK ("conversations"."project_id" is null or "conversations"."kind" = 'chat') NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_project_id_config_assets_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_project_chat_check";
