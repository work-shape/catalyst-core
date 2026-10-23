SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "personal_data_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operation_runs" ADD COLUMN "result_bytes" integer;
