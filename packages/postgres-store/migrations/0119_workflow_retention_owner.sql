-- Fail promptly rather than wait behind a busy workflow worker.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "workflow_runs" ALTER COLUMN "definition" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "data_prune_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
