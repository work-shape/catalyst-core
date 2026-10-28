-- The skills of a Personal Workspace its owner uses in their own chats (SCOPE-MYCHATS): a new,
-- empty table. Its foreign key locks config_assets briefly; a busy table fails the migration
-- instead of holding up writes.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "personal_chat_skills" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_chat_skills" ADD CONSTRAINT "personal_chat_skills_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;