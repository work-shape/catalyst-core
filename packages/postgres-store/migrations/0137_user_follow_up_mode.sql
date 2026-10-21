-- A constant default adds the column without a rewrite; the brief lock still waits at most 5s.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "product_users" ADD COLUMN "follow_up_mode" text DEFAULT 'queue' NOT NULL;
