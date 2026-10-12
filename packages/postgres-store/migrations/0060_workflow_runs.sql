CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"workflow" text NOT NULL,
	"definition_revision_id" text NOT NULL,
	"mode" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"definition" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"principal_id" text NOT NULL,
	"principal_name" text NOT NULL,
	"principal_label" text NOT NULL,
	"started_by" jsonb NOT NULL,
	"operation_run_id" text,
	"step_run_count" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "workflow_runs_client_id_key" UNIQUE("client_instance_id","id"),
	CONSTRAINT "workflow_runs_mode_check" CHECK ("workflow_runs"."mode" in ('live', 'test')),
	CONSTRAINT "workflow_runs_status_check" CHECK ("workflow_runs"."status" in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'limit_reached'))
);
--> statement-breakpoint
CREATE TABLE "workflow_step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"step_type" text NOT NULL,
	"key" text NOT NULL,
	"container_step_run_id" text,
	"branch" text,
	"iteration" integer,
	"iteration_label" text,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"operation_run_id" text,
	"effect" text,
	"source" text,
	"error" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "workflow_step_runs_status_check" CHECK ("workflow_step_runs"."status" in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled')),
	CONSTRAINT "workflow_step_runs_iteration_check" CHECK ("workflow_step_runs"."iteration" is null or "workflow_step_runs"."container_step_run_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_run_fk" FOREIGN KEY ("client_instance_id","run_id") REFERENCES "public"."workflow_runs"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_list_idx" ON "workflow_runs" USING btree ("client_instance_id","workflow","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_runs_key_idx" ON "workflow_step_runs" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "workflow_step_runs_list_idx" ON "workflow_step_runs" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "workflow_step_runs_container_idx" ON "workflow_step_runs" USING btree ("container_step_run_id","step_id","iteration") WHERE "workflow_step_runs"."container_step_run_id" is not null;