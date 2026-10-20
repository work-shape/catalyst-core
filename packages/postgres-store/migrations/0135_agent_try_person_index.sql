DROP INDEX CONCURRENTLY IF EXISTS "agent_try_conversations_build_idx";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "agent_try_conversations_current_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "agent_try_conversations_current_idx" ON "agent_try_conversations" USING btree ("client_instance_id","agent_id","created_by_user_id") WHERE "replaced_at" is null;
