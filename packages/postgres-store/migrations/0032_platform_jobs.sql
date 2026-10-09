CREATE TABLE "platform_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"run_after" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"dedupe_key" text,
	"concurrency_key" text,
	"error_code" text,
	"error_message" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "platform_jobs_claim_idx" ON "platform_jobs" USING btree ("client_instance_id","kind","status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_jobs_live_dedupe_idx" ON "platform_jobs" USING btree ("client_instance_id","kind","dedupe_key") WHERE "platform_jobs"."dedupe_key" is not null and "platform_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "platform_jobs_finished_idx" ON "platform_jobs" USING btree ("client_instance_id","finished_at");