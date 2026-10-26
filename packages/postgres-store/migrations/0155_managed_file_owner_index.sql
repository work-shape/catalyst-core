CREATE INDEX CONCURRENTLY IF NOT EXISTS "managed_files_owner_idx" ON "managed_files" USING btree ("client_instance_id","owner_kind","owner_id");
