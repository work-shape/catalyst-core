CREATE TABLE "agent_run_observations" (
	"client_instance_id" text NOT NULL,
	"run_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_run_observations_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"input_message_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"correlation_id" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_run_observations" ADD CONSTRAINT "agent_run_observations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_observations" ADD CONSTRAINT "agent_run_observations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_input_message_id_messages_id_fk" FOREIGN KEY ("input_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_observations_conversation_idx" ON "agent_run_observations" USING btree ("client_instance_id","conversation_id","run_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_run_observations_owner_created_idx" ON "agent_run_observations" USING btree ("client_instance_id","owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_conversation_idx" ON "agent_runs" USING btree ("client_instance_id","conversation_id") WHERE "agent_runs"."status" in ('queued', 'running', 'waiting_for_permission', 'cancelling');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_idempotency_idx" ON "agent_runs" USING btree ("client_instance_id","conversation_id","idempotency_key") WHERE "agent_runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_idx" ON "agent_runs" USING btree ("client_instance_id","conversation_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_owner_created_idx" ON "agent_runs" USING btree ("client_instance_id","owner_user_id","started_at" DESC NULLS LAST);