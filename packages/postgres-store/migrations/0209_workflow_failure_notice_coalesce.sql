-- The failure notice each root was counted into, and the root's count of failing runs, so a later
-- failing run of the same Workflow updates the person's unhandled notice instead of adding one.
-- Earlier markers name no notice: the first failing run after this release opens a fresh one.
-- Every existing row holds null, so the reference is added NOT VALID and scans nothing under the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "workflow_failure_notices" ADD COLUMN "notice_id" text;--> statement-breakpoint
ALTER TABLE "workflow_failure_notices" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_failure_notices" ADD CONSTRAINT "workflow_failure_notices_notice_id_approval_requests_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action NOT VALID;
