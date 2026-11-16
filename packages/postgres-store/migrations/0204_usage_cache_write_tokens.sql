-- The input of a model call that was written to a prompt cache, for a provider that reports it.
-- Null on every row written before the column and for a provider that reports no cache write.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "cache_write_input_tokens" integer;
