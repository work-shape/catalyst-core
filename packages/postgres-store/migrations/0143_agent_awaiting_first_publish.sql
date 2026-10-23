-- A new column with a constant default: no rewrite, every existing agent awaits nothing
-- (WS-PUB-1b). The ALTER locks the table briefly; a busy one fails the migration instead of
-- holding up chat.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "config_asset_availability" ADD COLUMN "awaiting_first_publish" boolean DEFAULT false NOT NULL;
