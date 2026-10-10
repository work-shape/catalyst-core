CREATE INDEX CONCURRENTLY IF NOT EXISTS "approval_requests_client_requester_idx" ON "approval_requests" USING btree ("client_instance_id",("requested_by"->>'id'),"created_at" DESC NULLS LAST);
