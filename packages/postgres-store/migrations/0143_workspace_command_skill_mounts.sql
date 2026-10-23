-- The skills a workspace command mounts read-only at /skills/<name>/ (SF-3): names, revisions
-- and versions, never content. A nullable column without a default adds no rewrite; every
-- existing row holds null and mounts nothing.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "workspace_commands" ADD COLUMN "skill_mounts" jsonb;
