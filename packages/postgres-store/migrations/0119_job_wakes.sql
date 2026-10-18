CREATE TABLE "platform_job_wakes" (
	"client_instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_after" timestamp with time zone NOT NULL,
	"subject" text,
	"concurrency_key" text,
	"concurrency_limit" integer,
	"correlation_id" text NOT NULL,
	CONSTRAINT "platform_job_wakes_client_instance_id_kind_dedupe_key_pk" PRIMARY KEY("client_instance_id","kind","dedupe_key")
);
--> statement-breakpoint
CREATE INDEX "platform_job_wakes_due_idx" ON "platform_job_wakes" USING btree ("client_instance_id","kind","run_after","dedupe_key");