ALTER TABLE "model_usage_events" ALTER COLUMN "agent_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "binding_id" text;--> statement-breakpoint
-- Added NOT VALID: the table is not read under the lock. 0043 validates.
ALTER TABLE "model_usage_events" ADD CONSTRAINT "model_usage_events_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD CONSTRAINT "model_usage_events_workspace_fk" FOREIGN KEY ("collaboration_workspace_id") REFERENCES "public"."collaboration_workspaces"("id") ON DELETE set null ON UPDATE no action NOT VALID;
