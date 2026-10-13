-- The table is written by every save of a repository. The change stops after five seconds
-- instead of queueing those writes behind its lock; the migration step is then run again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "asset_repo_bundles" ADD COLUMN "request" jsonb;--> statement-breakpoint
ALTER TABLE "asset_repo_bundles" ADD COLUMN "result" jsonb;