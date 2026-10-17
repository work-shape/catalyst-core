ALTER TABLE "platform_jobs" ADD COLUMN "concurrency_limit" integer;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "limits" jsonb DEFAULT '{"durationMs":43200000,"stepRuns":20000,"loopItems":10000}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "waited_ms" bigint DEFAULT 0 NOT NULL;