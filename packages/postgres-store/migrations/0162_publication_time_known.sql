SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "config_asset_publications" ADD COLUMN "published_at_known" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- The original backfill used updated_at when no publication event survived. A first
-- publication without an actor cannot be distinguished reliably from that fallback now:
-- its audit event may also have been pruned since. Hide the date conservatively. Keep the
-- stored timestamp for compatibility with older readers; new writes always know their time.
UPDATE "config_asset_publications" SET "published_at_known" = false
WHERE "number" = 1 AND "actor" IS NULL;
