-- The conversation list of a workspace, newest first, as an index range. Ascending with the
-- tie-break: Postgres reads it backwards for `order by updated_at desc, id desc`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_workspace_updated_idx" ON "conversations" USING btree ("client_instance_id","collaboration_workspace_id","status","updated_at","id");
