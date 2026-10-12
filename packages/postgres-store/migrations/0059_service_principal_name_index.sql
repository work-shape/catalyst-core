CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "service_principals_client_name_idx" ON "service_principals" USING btree ("client_instance_id","name");
