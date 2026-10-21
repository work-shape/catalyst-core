-- Steer becomes the default of what Enter does during a person's own run. No release carries
-- 0137, so no person has chosen yet: every row moves to the new default. One row per person;
-- the brief lock still waits at most 5s.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "product_users" ALTER COLUMN "follow_up_mode" SET DEFAULT 'steer';--> statement-breakpoint
UPDATE "product_users" SET "follow_up_mode" = 'steer' WHERE "follow_up_mode" = 'queue';
