ALTER TABLE "model_usage_events" ADD COLUMN IF NOT EXISTS "web_search_call_count" integer DEFAULT 0 NOT NULL;
