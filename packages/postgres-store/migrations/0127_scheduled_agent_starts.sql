CREATE TABLE "scheduled_start_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"scheduled_start_id" text,
	"scheduled_for" timestamp with time zone NOT NULL,
	"conversation_id" text,
	"agent_run_id" text,
	"status" text NOT NULL,
	"reason" text,
	"personal_connections_allowed" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_starts" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"collaboration_workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"prompt" text NOT NULL,
	"cron" text NOT NULL,
	"time_zone" text NOT NULL,
	"state" text NOT NULL,
	"next_run_at" timestamp with time zone,
	"personal_connections_allowed" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scheduled_starts_state_check" CHECK ("scheduled_starts"."state" in ('active', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "scheduled_start_runs" ADD CONSTRAINT "scheduled_start_runs_scheduled_start_id_scheduled_starts_id_fk" FOREIGN KEY ("scheduled_start_id") REFERENCES "public"."scheduled_starts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_start_runs" ADD CONSTRAINT "scheduled_start_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_start_runs" ADD CONSTRAINT "scheduled_start_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_starts" ADD CONSTRAINT "scheduled_starts_owner_fk" FOREIGN KEY ("client_instance_id","owner_user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_starts" ADD CONSTRAINT "scheduled_starts_workspace_fk" FOREIGN KEY ("client_instance_id","collaboration_workspace_id") REFERENCES "public"."collaboration_workspaces"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_start_runs_due_idx" ON "scheduled_start_runs" USING btree ("client_instance_id","scheduled_start_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_start_runs_agent_run_idx" ON "scheduled_start_runs" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "scheduled_start_runs_conversation_idx" ON "scheduled_start_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "scheduled_start_runs_created_idx" ON "scheduled_start_runs" USING btree ("scheduled_start_id","client_instance_id","created_at","id");--> statement-breakpoint
CREATE INDEX "scheduled_start_runs_latest_started_idx" ON "scheduled_start_runs" USING btree ("client_instance_id","scheduled_start_id","created_at","id") WHERE "scheduled_start_runs"."agent_run_id" is not null;--> statement-breakpoint
CREATE INDEX "scheduled_starts_owner_created_idx" ON "scheduled_starts" USING btree ("client_instance_id","owner_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "scheduled_starts_workspace_created_idx" ON "scheduled_starts" USING btree ("client_instance_id","collaboration_workspace_id","owner_user_id","created_at","id");