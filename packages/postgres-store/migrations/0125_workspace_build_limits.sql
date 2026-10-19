-- Build limits of a Shared Workspace (WS-BUILD-1): two nullable lists, null adds no limit.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "collaboration_workspaces" ADD COLUMN "allowed_tool_names" jsonb;--> statement-breakpoint
ALTER TABLE "collaboration_workspaces" ADD COLUMN "allowed_model_binding_ids" jsonb;
