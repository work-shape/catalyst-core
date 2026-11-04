-- A Shared Workspace may name its own default agent (null follows the instance default).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "collaboration_workspaces" ADD COLUMN "default_agent_name" text;