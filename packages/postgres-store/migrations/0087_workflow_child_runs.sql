ALTER TABLE "workflow_runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "parent_step_run_id" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "root_run_id" text;--> statement-breakpoint
UPDATE "workflow_runs" SET "root_run_id" = "id";--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "item_index" integer;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "item_label" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_depth_check" CHECK ("workflow_runs"."depth" between 0 and 2) NOT VALID;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_lineage_check" CHECK (("workflow_runs"."parent_run_id" is null and "workflow_runs"."parent_step_run_id" is null and "workflow_runs"."depth" = 0) or ("workflow_runs"."parent_run_id" is not null and "workflow_runs"."parent_step_run_id" is not null and "workflow_runs"."root_run_id" is not null and "workflow_runs"."depth" > 0)) NOT VALID;
