-- Every change here alters "conversations", "agent_runs", "agent_run_observations",
-- "model_usage_events" or "workflow_step_runs", and each needs a lock that every writer of
-- those busy tables waits behind. The migration gives up after five seconds instead of
-- queueing them, and the migration step is then run again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "collaboration_workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "created_by_external_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_observations" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "parent_conversation_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "root_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "parent_operation_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "workflow_step_run_id" text;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "agent_run_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_parent_conversation_id_conversations_id_fk" FOREIGN KEY ("parent_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_check" CHECK ("conversations"."kind" in ('chat', 'run_thread')) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_run_thread_check" CHECK (("conversations"."kind" = 'chat' and "conversations"."parent_conversation_id" is null and "conversations"."workflow_run_id" is null and "conversations"."collaboration_workspace_id" is not null and "conversations"."created_by_user_id" is not null and "conversations"."created_by_external_user_id" is not null) or ("conversations"."kind" = 'run_thread' and (("conversations"."parent_conversation_id" is not null and "conversations"."workflow_run_id" is null and "conversations"."collaboration_workspace_id" is not null and "conversations"."created_by_user_id" is not null and "conversations"."created_by_external_user_id" is not null) or ("conversations"."parent_conversation_id" is null and "conversations"."workflow_run_id" is not null and "conversations"."collaboration_workspace_id" is null and "conversations"."created_by_user_id" is null and "conversations"."created_by_external_user_id" is null)))) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_check" CHECK (("agent_runs"."owner_user_id" is null) <> ("agent_runs"."principal_id" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_lineage_check" CHECK (("agent_runs"."parent_run_id" is null and "agent_runs"."root_run_id" is null and "agent_runs"."parent_operation_run_id" is null and "agent_runs"."depth" = 0) or ("agent_runs"."parent_run_id" is not null and "agent_runs"."root_run_id" is not null and "agent_runs"."parent_operation_run_id" is not null and "agent_runs"."depth" = 1)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_started_by_check" CHECK ("agent_runs"."parent_operation_run_id" is null or "agent_runs"."workflow_step_run_id" is null) NOT VALID;
