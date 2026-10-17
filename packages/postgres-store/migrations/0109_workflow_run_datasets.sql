CREATE TABLE "workflow_dataset_readers" (
	"client_instance_id" text NOT NULL,
	"dataset_id" text NOT NULL,
	"run_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "workflow_dataset_readers_client_instance_id_dataset_id_run_id_pk" PRIMARY KEY("client_instance_id","dataset_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_dataset_usage" (
	"client_instance_id" text NOT NULL,
	"scope" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "workflow_dataset_usage_client_instance_id_scope_pk" PRIMARY KEY("client_instance_id","scope")
);
--> statement-breakpoint
CREATE TABLE "workflow_run_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_run_id" text NOT NULL,
	"field" text NOT NULL,
	"row_schema" jsonb NOT NULL,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_part" jsonb,
	"state" text DEFAULT 'writing' NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"cleaned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "workflow_dataset_readers_run_idx" ON "workflow_dataset_readers" USING btree ("client_instance_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_datasets_step_field_idx" ON "workflow_run_datasets" USING btree ("client_instance_id","step_run_id","field");--> statement-breakpoint
CREATE INDEX "workflow_run_datasets_run_idx" ON "workflow_run_datasets" USING btree ("client_instance_id","run_id","id");--> statement-breakpoint
CREATE INDEX "workflow_run_datasets_expiry_idx" ON "workflow_run_datasets" USING btree ("client_instance_id","expires_at","id") WHERE "workflow_run_datasets"."cleaned_at" is null;