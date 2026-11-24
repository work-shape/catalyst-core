-- The failure markers of one notice, summed when a later failing run updates it, and cleared when
-- the notice is deleted. Built without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_failure_notices_notice_idx" ON "workflow_failure_notices" USING btree ("notice_id");
