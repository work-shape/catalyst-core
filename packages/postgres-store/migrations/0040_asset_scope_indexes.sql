-- A name prefix (a Namespace's) as an index range.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "config_assets_client_kind_name_prefix_idx" ON "config_assets" USING btree ("client_instance_id","kind","name" text_pattern_ops);
