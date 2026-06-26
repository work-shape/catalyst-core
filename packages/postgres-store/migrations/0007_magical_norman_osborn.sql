CREATE TABLE "run_start_commands" (
	"client_instance_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_kind" text NOT NULL,
	"status" text NOT NULL,
	"conversation_id" text,
	"user_message_id" text,
	"run_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_start_commands" ADD CONSTRAINT "run_start_commands_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_start_commands" ADD CONSTRAINT "run_start_commands_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_start_commands" ADD CONSTRAINT "run_start_commands_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_start_commands_idempotency_idx" ON "run_start_commands" USING btree ("client_instance_id","owner_user_id","command_kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "run_start_commands_run_idx" ON "run_start_commands" USING btree ("client_instance_id","run_id");