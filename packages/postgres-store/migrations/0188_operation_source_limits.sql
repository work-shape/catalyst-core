-- EW-13a: an accepted operation's `limits` are admitted per operation beside the Connection's
-- own. A constant default adds no rewrite; rows of the Connection's own limits keep ''.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "connection_source_calls" ADD COLUMN "operation_name" text DEFAULT '' NOT NULL;
