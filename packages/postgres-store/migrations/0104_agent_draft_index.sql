-- No supported stable release uses proposal source indexes; rc.3 rollback is restricted.
-- contract-after: v0.6.3
DROP INDEX CONCURRENTLY IF EXISTS "agent_change_proposals_source_idx";
--> statement-breakpoint
-- contract-after: v0.6.3
DROP INDEX CONCURRENTLY IF EXISTS "agent_change_proposals_of_source_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "agent_change_proposals_agent_idx" ON "agent_change_proposals" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_try_conversations_agent_idx" ON "agent_try_conversations" USING btree ("client_instance_id", "agent_id", "conversation_id");
