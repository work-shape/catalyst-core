-- The conversations of a project page, newest first (PRJ-1). Built without blocking writes;
-- every existing row holds no project, so the partial index starts empty.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_project_updated_idx" ON "conversations" USING btree ("client_instance_id","project_id","status","updated_at","id") WHERE "conversations"."project_id" is not null;
