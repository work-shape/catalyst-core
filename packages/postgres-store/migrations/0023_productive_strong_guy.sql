ALTER TABLE "agent_runs" ADD COLUMN "model_binding_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
CREATE INDEX "agent_runs_queue_idx" ON "agent_runs" USING btree ("client_instance_id","status","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_lease_idx" ON "agent_runs" USING btree ("client_instance_id","status","lease_expires_at");