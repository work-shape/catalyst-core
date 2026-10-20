-- The uniqueness of a grant row without the Namespace, built beside the old index while it still
-- guards writes. 0127 left no Namespace row, so no two rows collide. A new name lets the runner
-- rebuild an invalid, cancelled build safely.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "permission_grants_scope_unique" ON "permission_grants" USING btree ("client_instance_id","holder_kind","holder_id","action","scope_kind",coalesce("scope_id", ''));
