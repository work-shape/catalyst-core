CREATE TABLE "operation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"operation" text NOT NULL,
	"effect" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor" jsonb NOT NULL,
	"owner_user_id" text,
	"collaboration_workspace_id" text,
	"origin_kind" text NOT NULL,
	"origin" jsonb NOT NULL,
	"conversation_id" text,
	"idempotency_key" text,
	"input_hash" text NOT NULL,
	"input_ref" text,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"decision" jsonb,
	"approval_request_id" text,
	"output" jsonb,
	"result_ref" text,
	"error" jsonb,
	"usage" jsonb,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operation_runs_effect_check" CHECK ("operation_runs"."effect" in ('reading', 'changing')),
	CONSTRAINT "operation_runs_actor_kind_check" CHECK ("operation_runs"."actor_kind" in ('user', 'service_principal')),
	CONSTRAINT "operation_runs_status_check" CHECK ("operation_runs"."status" in ('running', 'pending_confirmation', 'pending_approval', 'done', 'failed', 'denied', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "collaboration_workspace_id" text;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "operation_run_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "operation_runs_idempotency_idx" ON "operation_runs" USING btree ("client_instance_id","actor_id","idempotency_key") WHERE "operation_runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "operation_runs_client_created_idx" ON "operation_runs" USING btree ("client_instance_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "operation_runs_actor_created_idx" ON "operation_runs" USING btree ("client_instance_id","actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "operation_runs_open_idx" ON "operation_runs" USING btree ("client_instance_id","status","expires_at") WHERE "operation_runs"."status" in ('running', 'pending_confirmation', 'pending_approval');--> statement-breakpoint
CREATE INDEX "operation_runs_conversation_idx" ON "operation_runs" USING btree ("client_instance_id","conversation_id") WHERE "operation_runs"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "operation_runs_approval_request_idx" ON "operation_runs" USING btree ("approval_request_id") WHERE "operation_runs"."approval_request_id" is not null;