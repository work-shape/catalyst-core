ALTER TABLE "model_usage_events" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage_events" ALTER COLUMN "agent_run_id" DROP NOT NULL;