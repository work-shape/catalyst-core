-- PRJ-6: when the retention job noticed an idle project. Expand only: nullable, no default, so
-- no row is rewritten and a release before it reads the table as before. The column takes a
-- brief metadata lock on projects; refuse instead of waiting behind traffic.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "idle_notice_at" timestamp with time zone;
