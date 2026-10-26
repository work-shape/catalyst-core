-- Deleting a message removes the continuation stored with it. Without an index on the message,
-- each deleted message of a conversation reads the whole continuation table, and the turn
-- continuations hold a row for nearly every conversation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "model_provider_continuations_source_message_idx" ON "model_provider_continuations" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "model_provider_turn_continuations_source_message_idx" ON "model_provider_turn_continuations" USING btree ("source_message_id");
