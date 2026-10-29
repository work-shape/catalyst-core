-- Feedback on Apps and Workflow results (LU-6): one comment per person per run, a reviewer's
-- comments on an asset newest first, and a run's comments when it is removed. Built without
-- blocking writes; every existing comment names no asset or run.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "feedback_client_workflow_run_author_idx" ON "feedback" USING btree ("client_instance_id","workflow_run_id","author_user_id") WHERE "feedback"."workflow_run_id" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "feedback_client_asset_created_idx" ON "feedback" USING btree ("client_instance_id","asset_id","created_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "feedback_workflow_run_idx" ON "feedback" USING btree ("workflow_run_id") WHERE "feedback"."workflow_run_id" is not null;
