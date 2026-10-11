ALTER TABLE "page_builds" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "config_asset_revisions" ADD COLUMN "file_set_id" text;--> statement-breakpoint
ALTER TABLE "config_assets" ADD COLUMN "published_revision_id" text;