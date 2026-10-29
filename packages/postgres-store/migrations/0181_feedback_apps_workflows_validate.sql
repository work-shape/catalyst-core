-- Feedback on Apps and Workflow results (LU-6). In a transaction of its own: the scan holds only
-- a lock that reads and writes pass. Every existing comment is on a message and names no asset,
-- workspace or run, so every check passes.
ALTER TABLE "feedback" VALIDATE CONSTRAINT "feedback_asset_fk";--> statement-breakpoint
ALTER TABLE "feedback" VALIDATE CONSTRAINT "feedback_asset_workspace_fk";--> statement-breakpoint
ALTER TABLE "feedback" VALIDATE CONSTRAINT "feedback_workflow_run_fk";--> statement-breakpoint
ALTER TABLE "feedback" VALIDATE CONSTRAINT "feedback_subject_asset_check";--> statement-breakpoint
ALTER TABLE "feedback" VALIDATE CONSTRAINT "feedback_subject_kind_check";
