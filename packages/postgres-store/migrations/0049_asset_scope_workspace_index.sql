-- What a workspace owns, for its delete and for the foreign key. Instance assets are not in it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "config_assets_scope_idx" ON "config_assets" USING btree ("scope_id") WHERE "config_assets"."scope_id" is not null;
