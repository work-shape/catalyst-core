CREATE TABLE "execution_workspace_files" (
	"workspace_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"path" text NOT NULL,
	"object_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"checksum" text NOT NULL,
	"mime_type" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_command_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_workspace_files_pk" PRIMARY KEY("workspace_id","path")
);
--> statement-breakpoint
CREATE TABLE "execution_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_run_id" text,
	"tool_call_id" text,
	"command" text NOT NULL,
	"cwd" text,
	"status" text NOT NULL,
	"limits" jsonb NOT NULL,
	"expected_outputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cancellation_reason" text,
	"cancellation_requested_at" timestamp with time zone,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_workspace_files" ADD CONSTRAINT "execution_workspace_files_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_files" ADD CONSTRAINT "execution_workspace_files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_files" ADD CONSTRAINT "execution_workspace_files_last_command_id_workspace_commands_id_fk" FOREIGN KEY ("last_command_id") REFERENCES "public"."workspace_commands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_commands" ADD CONSTRAINT "workspace_commands_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_commands" ADD CONSTRAINT "workspace_commands_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_commands" ADD CONSTRAINT "workspace_commands_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_workspace_files_workspace_idx" ON "execution_workspace_files" USING btree ("client_instance_id","workspace_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "execution_workspace_files_object_key_idx" ON "execution_workspace_files" USING btree ("client_instance_id","object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_workspaces_conversation_idx" ON "execution_workspaces" USING btree ("client_instance_id","conversation_id");--> statement-breakpoint
CREATE INDEX "execution_workspaces_owner_idx" ON "execution_workspaces" USING btree ("client_instance_id","owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workspace_commands_workspace_idx" ON "workspace_commands" USING btree ("client_instance_id","workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_commands_agent_run_idx" ON "workspace_commands" USING btree ("client_instance_id","agent_run_id");--> statement-breakpoint
CREATE INDEX "workspace_commands_queue_idx" ON "workspace_commands" USING btree ("client_instance_id","status","queued_at");--> statement-breakpoint
CREATE INDEX "workspace_commands_lease_idx" ON "workspace_commands" USING btree ("client_instance_id","status","lease_expires_at");