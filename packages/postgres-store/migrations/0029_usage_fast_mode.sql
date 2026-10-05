ALTER TABLE "model_usage_events" ADD COLUMN "fast_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "provider_service_tier" text;