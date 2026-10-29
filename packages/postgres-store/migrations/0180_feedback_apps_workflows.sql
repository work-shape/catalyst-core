-- Feedback on Apps and Workflow results (LU-6): additive columns, and the subject check
-- widened. Nullable columns without a default add no rewrite. The keys and checks are added
-- NOT VALID, so the brief lock reads no row; 0181 validates them in a transaction of its own,
-- and 0182 builds the indexes without blocking writes. Every existing row is a comment on a
-- message.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- No supported release before LU-4 (v0.6.3) has the table; a release with it writes only
-- comments on messages, which the wider check below still holds.
-- contract-after: v0.6.3
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_subject_kind_check";--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "agent_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "asset_name" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "asset_id" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "asset_revision" integer;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "asset_workspace_id" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_asset_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_asset_workspace_fk" FOREIGN KEY ("asset_workspace_id") REFERENCES "public"."collaboration_workspaces"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workflow_run_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_subject_asset_check" CHECK (("feedback"."subject_kind" = 'message') = ("feedback"."agent_name" is not null) and ("feedback"."subject_kind" = 'message') = ("feedback"."asset_name" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_subject_kind_check" CHECK ("feedback"."subject_kind" in ('message', 'app', 'workflow_run')) NOT VALID;
