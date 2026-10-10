CREATE INDEX CONCURRENTLY IF NOT EXISTS "model_usage_events_pending_idx" ON "model_usage_events" USING btree ("client_instance_id","created_at") WHERE "model_usage_events"."status" = 'pending';
