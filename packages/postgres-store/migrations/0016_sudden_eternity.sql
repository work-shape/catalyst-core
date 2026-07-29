ALTER TABLE "model_usage_events" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "customer_billable_cost" jsonb;