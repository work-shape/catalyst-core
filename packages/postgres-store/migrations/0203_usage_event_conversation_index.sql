-- The cost of a conversation sums its usage events and those of its run threads (LU-7). Without this index each read scans the instance's events. Built without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "model_usage_events_conversation_idx" ON "model_usage_events" USING btree ("client_instance_id","conversation_id") WHERE "model_usage_events"."conversation_id" is not null;
