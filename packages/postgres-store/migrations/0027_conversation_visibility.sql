ALTER TABLE "collaboration_workspaces" ADD COLUMN "default_conversation_visibility" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
-- Hand-edited: the column default exists only to backfill existing rows to 'workspace', so no
-- existing Conversation changes its audience. It is dropped again so every insert must stamp
-- visibility explicitly.
ALTER TABLE "conversations" ADD COLUMN "visibility" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "visibility" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "conversations_workspace_visibility_idx" ON "conversations" USING btree ("client_instance_id","collaboration_workspace_id","visibility","created_by_user_id");--> statement-breakpoint
ALTER TABLE "collaboration_workspaces" ADD CONSTRAINT "collaboration_workspaces_personal_conversation_visibility_check" CHECK ("collaboration_workspaces"."kind" <> 'personal' or "collaboration_workspaces"."default_conversation_visibility" = 'workspace');
